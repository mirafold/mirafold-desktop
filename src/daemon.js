// Owning the Mirafold daemon as a child process.
//
// The daemon is the real product: it drives the agent CLIs through
// pseudo-terminals, watches the filesystem, and serves the UI over HTTP +
// WebSocket on loopback. This app is, almost exactly, the `mirafold` terminal
// launcher with the last step changed — instead of handing the daemon's URL to
// your system browser, we hand it to our own window.
//
// It runs as a SEPARATE PROCESS, not imported in-process, for three reasons:
//
//  1. Crash isolation. The daemon installs process-wide uncaughtException and
//     unhandledRejection handlers that log and then process.exit(1). In-process
//     that exit would be OUR process — the whole app would vanish mid-keystroke
//     with nothing on screen. As a child it's an exit code we can catch, report,
//     and offer to recover from, with the window still standing.
//  2. Event-loop isolation. Pseudo-terminal reads, agent streaming, filesystem
//     watch events and transcript serialization are continuous work. Sharing
//     one event loop with window management means a long synchronous chunk
//     freezes the UI.
//  3. Per-folder working directories. A child gets its cwd from spawn(). An
//     in-process daemon reads process.cwd(), which is global and effectively
//     one-shot — "open a second project" would need a full app restart.
//
// It is started with Electron's OWN binary under ELECTRON_RUN_AS_NODE=1, an
// Electron feature that makes the binary behave as a plain Node.js interpreter:
// no Chromium, no window. That is what lets this app run on a machine with no
// Node.js installed, which is the entire point of shipping a desktop build.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialSafeLineStream, appendStderr } from "./daemon-output.js";
import { daemonEnv } from "./login-env.js";
import { LinuxProcessTreeTracker, terminateProcessTree } from "./process-tree.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_BOOTSTRAP = path.join(HERE, "daemon-bootstrap.cjs");
const WINDOWS_DAEMON_JOB = path.join(HERE, "windows-daemon-job.ps1");
const PID_LEDGER_ENV = "MIRAFOLD_DESKTOP_PID_LEDGER";
const WINDOWS_STOP_EVENT_ENV = "MIRAFOLD_DESKTOP_WINDOWS_STOP_EVENT";

// Each independently useful startup phase receives this full budget. Windows
// first compiles and configures its kill-on-close Job Object wrapper, then
// launches the actual daemon; a single timer across both phases made a slow
// PowerShell Add-Type compile consume nearly all of the daemon's URL budget.
// Linux has no wrapper phase and retains the original one-minute URL deadline.
const STARTUP_PHASE_TIMEOUT_MS = 60_000;
export const WINDOWS_WRAPPER_READY_MARKER = "MIRAFOLD_DESKTOP_WINDOWS_WRAPPER_READY";

/**
 * Absolute path to the daemon entry point.
 *
 * Ordinary resolution works in the packaged build too, because asar is off
 * (electron-builder.yml explains why): the app ships as a real directory, so
 * this child — an ordinary Node process — reads the `mirafold` package
 * straight from disk, exactly as in a dev checkout.
 */
function daemonPath() {
  return require.resolve("mirafold/dist-server/index.js");
}

/** Build the platform-specific command that owns the complete daemon tree. */
export function daemonLaunchSpec({
  platform = process.platform,
  executable = process.execPath,
  bootstrapEntry = DAEMON_BOOTSTRAP,
  daemonEntry = daemonPath(),
  windowsJobEntry = WINDOWS_DAEMON_JOB,
  env,
}) {
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    return {
      command: path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsJobEntry,
        executable,
        bootstrapEntry,
        daemonEntry,
      ],
      env: childEnv,
      detached: false,
    };
  }
  return {
    command: executable,
    args: [bootstrapEntry, daemonEntry],
    env: childEnv,
    detached: true,
  };
}

/**
 * The daemon's URL, read off its stdout.
 *
 * Matched against an ACCUMULATED tail rather than each chunk. This is ported
 * deliberately from the terminal launcher (`bin/mirafold.js`), which learned it
 * the hard way on 2026-07-28: a boot line split across two `data` events
 * matched neither chunk on its own, and the browser silently never opened. The
 * `(?=\s)` lookahead insists on a character AFTER the URL, so a chunk that ends
 * mid-token can't yield a truncated URL. The `\S*` captures the `?token=` query
 * the daemon mints per launch.
 *
 * Reading the URL rather than dictating it is intentional. The daemon picks its
 * own auth token and walks past a busy port (a second copy of the app, another
 * project in another window, an unrelated dev server on :3000), so its final
 * URL is a fact to be observed, not one we can assume.
 */
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\/\S*(?=\s)/;

/** Return the daemon's complete private startup URL, or null while incomplete. */
export function findStartupUrl(text) {
  return text.match(URL_RE)?.[0] ?? null;
}

/**
 * Own the bounded pre-URL startup phases without tying them to wall-clock
 * sleeps in tests. The Windows wrapper emits one constant, credential-free
 * line only after its Job Object and stop event are ready; that handshake
 * starts a fresh daemon URL deadline. Other platforms keep one URL deadline.
 */
export function createStartupDeadline({
  platform = process.platform,
  timeoutMs = STARTUP_PHASE_TIMEOUT_MS,
  onTimeout,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
} = {}) {
  if (typeof onTimeout !== "function") throw new TypeError("startup timeout callback is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("startup timeout must be positive");

  let phase = platform === "win32" ? "windows-wrapper" : "daemon-url";
  let markerTail = "";
  let timer = null;

  const timeoutMessage = (armedPhase) => armedPhase === "windows-wrapper"
    ? "the Windows daemon wrapper never became ready"
    : "the daemon started but never reported a URL";
  const arm = () => {
    if (timer !== null) cancelTimeout(timer);
    const armedPhase = phase;
    timer = scheduleTimeout(() => {
      timer = null;
      onTimeout(timeoutMessage(armedPhase));
    }, timeoutMs);
  };

  arm();
  return {
    observe(text) {
      if (phase !== "windows-wrapper") return false;
      const combined = markerTail + String(text);
      if (!combined.split(/\r?\n/u).includes(WINDOWS_WRAPPER_READY_MARKER)) {
        markerTail = combined.slice(-(WINDOWS_WRAPPER_READY_MARKER.length + 2));
        return false;
      }
      phase = "daemon-url";
      markerTail = "";
      arm();
      return true;
    },
    clear() {
      if (timer === null) return;
      cancelTimeout(timer);
      timer = null;
    },
    get phase() {
      return phase;
    },
  };
}

export class Daemon {
  #child = null;
  #ledgerDirectory = null;
  #ledgerFile = null;
  #treeTracker = null;
  #stopping = false;
  #stopPromise = null;
  #windowsStopEvent = null;
  #stderr = [];

  /** @param {(info: {code: number|null, signal: string|null, stderr: string, clean: boolean}) => void} onCrash */
  constructor(onCrash) {
    this.onCrash = onCrash;
  }

  get running() {
    return this.#child !== null;
  }

  /**
   * Boot the daemon with `folder` as its working directory — which is what makes
   * the folder picker meaningful, since sessions default to the daemon's cwd.
   * Resolves with the URL to load; rejects if the daemon dies or goes quiet.
   */
  async start(folder) {
    if (this.#child) throw new Error("daemon already running");
    this.#stderr = [];
    this.#stopping = false;
    this.#stopPromise = null;

    const env = await daemonEnv();
    // stop() may have landed while we awaited the login shell — the window
    // between start() and the spawn. Spawning now would create a daemon that
    // nothing will ever kill.
    if (this.#stopping) throw new Error("stopped before the daemon was spawned");
    let ledgerFile = null;
    if (process.platform === "linux") {
      this.#ledgerDirectory = mkdtempSync(path.join(tmpdir(), "mirafold-desktop-daemon-"));
      ledgerFile = path.join(this.#ledgerDirectory, "owned-processes");
      try {
        writeFileSync(ledgerFile, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        this.#cleanLedger();
        throw error;
      }
      this.#ledgerFile = ledgerFile;
      env[PID_LEDGER_ENV] = ledgerFile;
    }
    if (process.platform === "win32") {
      this.#windowsStopEvent = `Local\\MirafoldDesktopStop-${randomUUID()}`;
      env[WINDOWS_STOP_EVENT_ENV] = this.#windowsStopEvent;
    }
    const launch = daemonLaunchSpec({ env });
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: folder,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        // Unix: put the daemon in its OWN process group so that stopping it can
        // signal the whole group and take the agent CLIs it spawned with it.
        // See stop() — without this there is no way to reach grandchildren.
        detached: launch.detached,
      });
    } catch (error) {
      this.#cleanLedger();
      this.#windowsStopEvent = null;
      throw error;
    }
    this.#child = child;
    this.#treeTracker = child.pid ? new LinuxProcessTreeTracker(child.pid, 25, ledgerFile) : null;

    const safeStdout = new CredentialSafeLineStream();
    const safeStderr = new CredentialSafeLineStream();
    const forwardStdout = (text) => {
      if (text) process.stdout.write(text);
    };
    const forwardStderr = (text) => {
      if (!text) return;
      process.stderr.write(text);
      this.#stderr = appendStderr(this.#stderr, text);
    };
    const flushOutput = () => {
      forwardStdout(safeStdout.end());
      forwardStderr(safeStderr.end());
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      forwardStderr(safeStderr.push(text));
    });
    child.stderr.once("end", () => forwardStderr(safeStderr.end()));

    const url = await new Promise((resolve, reject) => {
      let tail = "";
      let settled = false;
      let deadline = null;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        deadline?.clear();
        fn(arg);
      };

      deadline = createStartupDeadline({
        onTimeout: (message) => done(reject, new Error(message)),
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        // Only the sanitizer's output leaves this process. `tail` still sees
        // the private text because the token is what makes the URL usable.
        forwardStdout(safeStdout.push(text));
        if (settled) return;
        deadline.observe(text);
        tail = (tail + text).slice(-4096); // one boot line, bounded
        const startupUrl = findStartupUrl(tail);
        if (startupUrl) {
          tail = "";
          done(resolve, startupUrl);
        }
      });
      child.stdout.once("end", () => forwardStdout(safeStdout.end()));

      // Dying before it says anything is the common shape of a broken launch —
      // a missing dependency, an unreadable folder, a port walk that ran out.
      // `close`, unlike `exit`, waits for its output pipes, so the diagnostic
      // buffer is complete before it is attached to the startup error.
      child.once("close", (code, signal) => {
        flushOutput();
        done(reject, new Error(`the daemon exited (${signal ?? `code ${code}`}) before starting`));
      });
      child.once("error", (err) => done(reject, err));
    }).catch(async (err) => {
      this.#child = null;
      const trackedIdentities = this.#takeTreeSnapshot();
      // The daemon may have spawned agent CLIs before failing, so take down
      // the whole tree, not just the daemon. Straight to SIGKILL: the boot
      // never completed, so there is nothing worth a graceful shutdown.
      if (child.pid) {
        await terminateProcessTree(child.pid, trackedIdentities, {
          termTimeoutMs: 0,
          ledgerFile: this.#ledgerFile,
        });
      }
      this.#cleanLedger();
      this.#windowsStopEvent = null;
      flushOutput();
      err.stderr = this.stderr;
      throw err;
    });

    // Boot succeeded, so from here a close is news. The listener above has
    // already fired-or-not; this one owns the rest of the process's life.
    child.once("close", (code, signal) => {
      flushOutput();
      this.#child = null;
      const trackedIdentities = this.#takeTreeSnapshot();
      if (this.#stopping) return; // we asked for it
      // The Windows wrapper could reach this close only after it configured
      // and joined its Job Object, then started Electron. Its last job handle
      // has now closed, which is the OS-owned crash cleanup proof. On Unix the
      // retained identities remain necessary and are checked directly.
      const cleanup = process.platform === "win32"
        ? Promise.resolve(true)
        : terminateProcessTree(child.pid, trackedIdentities, { ledgerFile: this.#ledgerFile });
      this.#stopPromise = cleanup.finally(() => {
        this.#cleanLedger();
        this.#windowsStopEvent = null;
      });
      void this.#stopPromise.then((clean) => {
        if (!this.#stopping) this.onCrash?.({ code, signal, stderr: this.stderr, clean });
      });
    });

    return url;
  }

  /** The tail of the daemon's stderr, for the crash dialog. */
  get stderr() {
    return this.#stderr.join("\n");
  }

  #takeTreeSnapshot() {
    const tracker = this.#treeTracker;
    this.#treeTracker = null;
    return tracker?.stop() ?? [];
  }

  #cleanLedger() {
    const directory = this.#ledgerDirectory;
    this.#ledgerDirectory = null;
    this.#ledgerFile = null;
    if (!directory) return;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // PID/start-time records contain no credentials. A temporary-file
      // cleanup failure must not turn a proven process shutdown into a failed
      // quit or invite a second teardown attempt against reused PIDs.
    }
  }

  /**
   * Stop the daemon AND everything it started (see killTree). SIGTERM first
   * so the daemon can close sockets, SIGKILL after a grace period for
   * anything ignoring it; on Windows a named event terminates the owning Job.
   */
  stop() {
    // Set before the child check: start() consults it between its env await
    // and the spawn, so a stop that lands pre-spawn still takes effect.
    this.#stopping = true;
    if (this.#stopPromise) return this.#stopPromise;
    const child = this.#child;
    if (!child?.pid) {
      this.#cleanLedger();
      this.#windowsStopEvent = null;
      return Promise.resolve(true);
    }
    this.#child = null;
    const trackedIdentities = this.#takeTreeSnapshot();
    const windowsJobClosed = process.platform === "win32"
      ? new Promise((resolve) => child.once("close", resolve))
      : null;
    this.#stopPromise = terminateProcessTree(child.pid, trackedIdentities, {
      ledgerFile: this.#ledgerFile,
      // A startup URL can only arrive after the PowerShell wrapper has created
      // its Job and launched the daemon, so the wrapper is now a valid OS-owned
      // process-tree boundary. The pre-start failure path deliberately omits
      // this flag because Job setup may not have completed there.
      windowsJobOwned: process.platform === "win32",
      windowsJobClosed,
      windowsStopEvent: this.#windowsStopEvent,
      windowsEnv: process.env,
    }).finally(() => {
      this.#cleanLedger();
      this.#windowsStopEvent = null;
    });
    return this.#stopPromise;
  }
}
