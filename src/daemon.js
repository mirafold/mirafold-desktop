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
import { createRequire } from "node:module";
import { daemonEnv } from "./login-env.js";

const require = createRequire(import.meta.url);

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
 * Kill `pid` and everything it spawned. The daemon starts the agent CLIs as
 * its own children, so signalling only the daemon leaves those running —
 * invisible processes holding an API session open after the user believes
 * they quit. Every path that ends the daemon must go through here.
 *
 * Unix: signal the process GROUP (the negative pid), which detached:true made
 * the daemon the leader of. Windows: `taskkill /T` walks the process tree,
 * the only reliable way there — Windows has no process groups in the Unix
 * sense — and `/F` makes it final, so `signal` is a Unix-only distinction.
 */
function killTree(pid, signal) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    // Fire-and-forget callers (a failed boot and ordinary app quit) must not
    // turn a missing taskkill executable into an unhandled EventEmitter error.
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
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A normal app quit may ignore stop()'s returned promise. Preserve the old
    // behavior in that path: a cleanup poll alone must not hold Electron open.
    timer.unref?.();
  });
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
 * Ordinary lifecycle callers may ignore the Promise and retain the existing
 * immediate-shutdown behavior; the update path awaits and checks it.
 *
 * @param {number} pid daemon/process-group leader
 * @returns {Promise<boolean>} true only after clean tree termination is proven
 */
export async function terminateProcessTree(pid) {
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
      timeout.unref?.();
      // Only taskkill's successful /T completion proves the descendants were
      // included. A vanished leader after a taskkill error says nothing about
      // children that may already have been re-parented, so fail closed.
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(code === 0));
    });
  }

  killTree(pid, "SIGTERM");
  if (await waitUntil(() => unixProcessGroupExists(pid), 4000)) return true;
  killTree(pid, "SIGKILL");
  return waitUntil(() => unixProcessGroupExists(pid), 2000);
}

export class Daemon {
  #child = null;
  #stopping = false;
  #stopPromise = null;
  #stderr = [];

  /** @param {(info: {code: number|null, signal: string|null, stderr: string}) => void} onCrash */
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
    const child = spawn(process.execPath, [daemonPath()], {
      cwd: folder,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // Unix: put the daemon in its OWN process group so that stopping it can
      // signal the whole group and take the agent CLIs it spawned with it. See
      // stop() — without this there is no way to reach the grandchildren.
      detached: process.platform !== "win32",
    });
    this.#child = child;

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
    }).catch((err) => {
      this.#child = null;
      // The daemon may have spawned agent CLIs before failing, so take down
      // the whole tree, not just the daemon. Straight to SIGKILL: the boot
      // never completed, so there is nothing worth a graceful shutdown.
      if (child.pid) killTree(child.pid, "SIGKILL");
      flushOutput();
      err.stderr = this.stderr;
      throw err;
    });

    // Boot succeeded, so from here a close is news. The listener above has
    // already fired-or-not; this one owns the rest of the process's life.
    child.once("close", (code, signal) => {
      flushOutput();
      this.#child = null;
      if (this.#stopping) return; // we asked for it
      this.onCrash?.({ code, signal, stderr: this.stderr });
    });

    return url;
  }

  /** The tail of the daemon's stderr, for the crash dialog. */
  get stderr() {
    return this.#stderr.join("\n");
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
    if (!child?.pid) return Promise.resolve(true);
    this.#child = null;
    this.#stopPromise = terminateProcessTree(child.pid);
    return this.#stopPromise;
  }
}
