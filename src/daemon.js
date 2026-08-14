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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonEnv } from "./login-env.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_BOOTSTRAP = path.join(HERE, "daemon-bootstrap.cjs");
const WINDOWS_DAEMON_JOB = path.join(HERE, "windows-daemon-job.ps1");
const PID_LEDGER_ENV = "MIRAFOLD_DESKTOP_PID_LEDGER";

// How long to wait for the daemon to announce its URL before calling the boot a
// failure. Generous: a cold start can pay for filesystem crawling on a large
// repo. The failure path shows the daemon's own stderr, so an overrun is
// diagnosable rather than mysterious.
const BOOT_TIMEOUT_MS = 60_000;

// Stderr kept for the crash dialog. Bounded because a daemon in a failure loop
// can produce output without limit, and this is held in memory for the life of
// the app. Bounded in BOTH directions — a hundred lines of unlimited length is
// not a bound, and agent output (which can be as long as a file someone else
// wrote) reaches this stream.
const STDERR_LINES = 100;
const STDERR_LINE_CHARS = 1000;

// A child stream can split anywhere — including between `tok` and `en=`, or
// between the pairing-code label and its value. Sanitizing each `data` chunk is
// therefore not sanitizing the stream. Hold one logical line until its newline,
// redact it as a whole, and elide rather than accumulate an attacker-sized line.
// The limit is deliberately larger than any legitimate Mirafold diagnostic;
// stderr is bounded more tightly again before it reaches a crash dialog.
const OUTPUT_LINE_CHARS = 16_384;
const OUTPUT_LINE_ELISION = "[mirafold desktop] overlong daemon output line elided";

// The daemon mints both values. The auth token grants local daemon access; the
// relay pairing code grants remote session access. Anything that leaves this
// process — mirrored child output or crash text — must strip both. The app's
// stdout/stderr is captured by the system journal when launched from a desktop
// menu, and a crash dialog is exactly what a user screenshots and shares.
const TOKEN_RE = /([?&]token=)[^\s&"'<>]+/gi;
const PAIRING_CODE_RE = /(\bpairing code\s*:\s*)[A-Za-z0-9_-]+/gi;

/** Replace complete credential values in one logical piece of text. */
export function redactCredentials(text) {
  return text.replace(TOKEN_RE, "$1<redacted>").replace(PAIRING_CODE_RE, "$1<redacted>");
}

/**
 * Turn arbitrarily chunked child output into credential-safe logical lines.
 *
 * `push()` returns only complete lines. `end()` safely releases a final line
 * without a newline. Once a logical line crosses the memory bound, none of its
 * prefix is released: the whole line becomes one fixed, non-secret marker.
 */
export class CredentialSafeLineStream {
  #pending = "";
  #dropping = false;
  #ended = false;

  push(text) {
    if (this.#ended || !text) return "";

    let safe = "";
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const complete = newline !== -1;
      const end = complete ? newline : text.length;
      const part = text.slice(start, end);

      if (!this.#dropping) {
        if (this.#pending.length + part.length > OUTPUT_LINE_CHARS) {
          this.#pending = "";
          this.#dropping = true;
        } else {
          this.#pending += part;
        }
      }

      if (!complete) break;
      safe += this.#dropping
        ? `${OUTPUT_LINE_ELISION}\n`
        : `${redactCredentials(this.#pending)}\n`;
      this.#pending = "";
      this.#dropping = false;
      start = newline + 1;
    }
    return safe;
  }

  end() {
    if (this.#ended) return "";
    this.#ended = true;
    const safe = this.#dropping ? OUTPUT_LINE_ELISION : redactCredentials(this.#pending);
    this.#pending = "";
    this.#dropping = false;
    return safe;
  }
}

/**
 * Append `text`'s non-blank lines to `lines`, bounded by line count and line
 * length. The live path passes stream-sanitized text; redacting again keeps
 * this helper safe for complete standalone diagnostics and future callers.
 */
export function appendStderr(lines, text) {
  const next = lines.slice();
  for (const line of redactCredentials(text).split("\n")) {
    if (line.trim()) next.push(line.slice(0, STDERR_LINE_CHARS));
  }
  return next.length > STDERR_LINES ? next.slice(-STDERR_LINES) : next;
}

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

// Linux pseudo-terminals start their foreground process in a new session and
// process group. The daemon's own group therefore cannot, by itself, describe
// everything the daemon owns. `/proc` exposes both ancestry and a process's
// kernel start time; retaining the pair guards a later cleanup against
// signalling an unrelated process that reused an exited child's PID.
function readLinuxProcessIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return null;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    if (fields.length < 20) return null;
    const ppid = Number(fields[1]);
    const processGroup = Number(fields[2]);
    if (!Number.isInteger(ppid) || !Number.isInteger(processGroup)) return null;
    return {
      pid,
      ppid,
      processGroup,
      state: fields[0],
      startTime: fields[19],
    };
  } catch {
    return null;
  }
}

function processIdentityKey(identity) {
  return `${identity.pid}:${identity.startTime}`;
}

function currentLinuxIdentity(identity) {
  const current = readLinuxProcessIdentity(identity?.pid);
  return current?.startTime === identity?.startTime ? current : null;
}

function runningLinuxIdentity(identity) {
  const current = currentLinuxIdentity(identity);
  return current !== null && current.state !== "Z" && current.state !== "X";
}

function linuxChildPids(identity) {
  if (!currentLinuxIdentity(identity)) return [];
  const children = new Set();
  try {
    for (const task of readdirSync(`/proc/${identity.pid}/task`)) {
      if (!/^\d+$/.test(task)) continue;
      try {
        const contents = readFileSync(`/proc/${identity.pid}/task/${task}/children`, "utf8");
        for (const value of contents.trim().split(/\s+/)) {
          if (/^\d+$/.test(value)) children.add(Number(value));
        }
      } catch {
        // A thread or child can exit between the directory and file reads.
      }
    }
  } catch {
    // The parent exited while it was being sampled.
  }
  return [...children];
}

function rememberLinuxDescendants(identities) {
  const queue = [...identities.values()];
  const visited = new Set();
  while (queue.length > 0) {
    const parent = queue.shift();
    const parentKey = processIdentityKey(parent);
    if (visited.has(parentKey)) continue;
    visited.add(parentKey);

    for (const childPid of linuxChildPids(parent)) {
      if (childPid === process.pid) continue;
      const child = readLinuxProcessIdentity(childPid);
      if (!child) continue;
      const childKey = processIdentityKey(child);
      if (!identities.has(childKey)) identities.set(childKey, child);
      queue.push(child);
    }
  }
  for (const [key, identity] of identities) {
    if (!runningLinuxIdentity(identity)) identities.delete(key);
  }
  return identities;
}

function rememberLinuxLedger(identities, ledgerFile) {
  if (!ledgerFile) return identities;
  let text;
  try {
    text = readFileSync(ledgerFile, "utf8");
  } catch {
    return identities;
  }
  // Each append is one short synchronous write. Ignore an incomplete tail
  // defensively, then corroborate every record against /proc so a stale or
  // reused PID can never authorize a signal.
  const completeText = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  for (const line of completeText.split("\n")) {
    const match = line.match(/^([1-9]\d*):(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const identity = readLinuxProcessIdentity(pid);
    if (identity?.startTime !== match[2] || identity.pid === process.pid) continue;
    identities.set(processIdentityKey(identity), identity);
  }
  return identities;
}

/**
 * Retain Linux descendant identities while their ancestry is still observable.
 * A daemon crash can re-parent its PTY children before the `close` event, so a
 * final point-in-time tree walk is not sufficient on that path.
 */
export class LinuxProcessTreeTracker {
  #identities = new Map();
  #ledgerFile = null;
  #timer = null;

  constructor(pid, intervalMs = 25, ledgerFile = null) {
    if (process.platform !== "linux") return;
    this.#ledgerFile = ledgerFile;
    const root = readLinuxProcessIdentity(pid);
    if (root) this.#identities.set(processIdentityKey(root), root);
    this.#capture();
    this.#timer = setInterval(() => this.#capture(), intervalMs);
    this.#timer.unref?.();
  }

  #captureLedger() {
    rememberLinuxLedger(this.#identities, this.#ledgerFile);
  }

  #capture() {
    this.#captureLedger();
    rememberLinuxDescendants(this.#identities);
  }

  snapshot() {
    this.#capture();
    return [...this.#identities.values()].map((identity) => ({ ...identity }));
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    return this.snapshot();
  }
}

/**
 * Kill `pid` and everything it spawned. The daemon starts the agent CLIs as
 * its own children, so signalling only the daemon leaves those running —
 * invisible processes holding an API session open after the user believes
 * they quit. Every path that ends the daemon must go through here.
 *
 * Unix: signal the daemon process GROUP (the negative pid), which detached:true
 * made it the leader of. Linux termination supplements this primitive with the
 * tracked identities above for separately grouped PTYs. Windows normally uses
 * `taskkill /T`; the daemon also runs inside a kill-on-close Job Object so a
 * daemon crash cannot erase the only ancestry Windows could walk.
 */
function killTree(pid, signal) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    // The awaited termination wrapper owns this error event. Keep the process
    // itself safe until that wrapper attaches its proof listeners below.
    killer.once("error", () => {});
    return killer;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* group already gone */
  }
  return null;
}

function unixProcessGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

/**
 * Stop a complete daemon/agent process tree and report whether it is gone.
 *
 * This is stricter than merely signalling the tree. The updater must not start
 * an installer while any process still has the old application files open.
 * Every lifecycle caller awaits this Promise. Keeping the bounded polling
 * timers referenced is what gives SIGKILL escalation time to finish during an
 * ordinary application quit.
 *
 * @param {number} pid daemon/process-group leader
 * @param {Array<object>} trackedIdentities Linux identities retained before a
 *   daemon crash could erase their ancestry
 * @param {{termTimeoutMs?: number, killTimeoutMs?: number, ledgerFile?: string|null}} timings
 *   bounded waits plus the private Linux creation ledger; exposed so focused
 *   tests do not spend four seconds escalating
 * @returns {Promise<boolean>} true only after clean tree termination is proven
 */
export async function terminateProcessTree(pid, trackedIdentities = [], timings = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return true;

  if (process.platform === "win32") {
    const killer = killTree(pid, "SIGTERM");
    if (!killer) return !processExists(pid);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (clean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(clean);
      };
      const timeout = setTimeout(() => {
        killer.kill();
        finish(false);
      }, 10_000);
      // Only taskkill's successful /T completion proves the descendants were
      // included. A vanished leader after a taskkill error says nothing about
      // children that may already have been re-parented, so fail closed.
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(code === 0));
    });
  }

  if (process.platform === "linux") {
    const identities = new Map();
    for (const identity of trackedIdentities) {
      if (
        Number.isInteger(identity?.pid) &&
        identity.pid > 0 &&
        typeof identity.startTime === "string"
      ) {
        identities.set(processIdentityKey(identity), identity);
      }
    }
    const retainedRoot = [...identities.values()].find((identity) => identity.pid === pid) ?? null;
    const currentRoot = retainedRoot === null ? readLinuxProcessIdentity(pid) : null;
    if (currentRoot) identities.set(processIdentityKey(currentRoot), currentRoot);
    const ledgerFile = timings.ledgerFile ?? null;
    rememberLinuxLedger(identities, ledgerFile);
    rememberLinuxDescendants(identities);

    const rootIdentity = retainedRoot ?? currentRoot;
    const originalGroupIsOwned = currentLinuxIdentity(rootIdentity) !== null;
    const termSignalled = new Set();
    const killSignalled = new Set();

    const signalNewIdentities = (signal, signalled) => {
      rememberLinuxLedger(identities, ledgerFile);
      rememberLinuxDescendants(identities);
      for (const identity of identities.values()) {
        const key = processIdentityKey(identity);
        if (signalled.has(key) || !runningLinuxIdentity(identity)) continue;
        signalled.add(key);
        try {
          process.kill(identity.pid, signal);
        } catch {
          // It exited after the identity check.
        }
      }
    };
    const treeExists = (signal, signalled) => {
      signalNewIdentities(signal, signalled);
      return (
        (originalGroupIsOwned && unixProcessGroupExists(pid)) ||
        [...identities.values()].some(runningLinuxIdentity)
      );
    };

    if (originalGroupIsOwned) killTree(pid, "SIGTERM");
    signalNewIdentities("SIGTERM", termSignalled);
    const termTimeoutMs = timings.termTimeoutMs ?? 4000;
    if (await waitUntil(() => treeExists("SIGTERM", termSignalled), termTimeoutMs)) return true;

    if (originalGroupIsOwned) killTree(pid, "SIGKILL");
    signalNewIdentities("SIGKILL", killSignalled);
    const killTimeoutMs = timings.killTimeoutMs ?? 2000;
    return waitUntil(() => treeExists("SIGKILL", killSignalled), killTimeoutMs);
  }

  killTree(pid, "SIGTERM");
  if (await waitUntil(() => unixProcessGroupExists(pid), 4000)) return true;
  killTree(pid, "SIGKILL");
  return waitUntil(() => unixProcessGroupExists(pid), 2000);
}

export class Daemon {
  #child = null;
  #ledgerDirectory = null;
  #ledgerFile = null;
  #treeTracker = null;
  #stopping = false;
  #stopPromise = null;
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
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      const timer = setTimeout(
        () => done(reject, new Error("the daemon started but never reported a URL")),
        BOOT_TIMEOUT_MS,
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        // Only the sanitizer's output leaves this process. `tail` still sees
        // the private text because the token is what makes the URL usable.
        forwardStdout(safeStdout.push(text));
        if (settled) return;
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
   * anything ignoring it; on Windows the first taskkill is already final.
   */
  stop() {
    // Set before the child check: start() consults it between its env await
    // and the spawn, so a stop that lands pre-spawn still takes effect.
    this.#stopping = true;
    if (this.#stopPromise) return this.#stopPromise;
    const child = this.#child;
    if (!child?.pid) {
      this.#cleanLedger();
      return Promise.resolve(true);
    }
    this.#child = null;
    const trackedIdentities = this.#takeTreeSnapshot();
    this.#stopPromise = terminateProcessTree(child.pid, trackedIdentities, {
      ledgerFile: this.#ledgerFile,
    }).finally(() => {
      this.#cleanLedger();
    });
    return this.#stopPromise;
  }
}
