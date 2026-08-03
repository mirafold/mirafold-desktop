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
// the app.
const STDERR_LINES = 100;

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

export class Daemon {
  #child = null;
  #stopping = false;
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

    const env = await daemonEnv();
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

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      process.stderr.write(text); // still useful when run from a terminal
      for (const line of text.split("\n")) {
        if (line.trim()) this.#stderr.push(line);
      }
      if (this.#stderr.length > STDERR_LINES) {
        this.#stderr = this.#stderr.slice(-STDERR_LINES);
      }
    });

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
        process.stdout.write(text);
        if (settled) return;
        tail = (tail + text).slice(-4096); // one boot line, bounded
        const match = tail.match(URL_RE);
        if (match) done(resolve, match[0]);
      });

      // Dying before it says anything is the common shape of a broken launch —
      // a missing dependency, an unreadable folder, a port walk that ran out.
      child.once("exit", (code, signal) =>
        done(reject, new Error(`the daemon exited (${signal ?? `code ${code}`}) before starting`)),
      );
      child.once("error", (err) => done(reject, err));
    }).catch((err) => {
      this.#child = null;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone — that's usually why we're here */
      }
      err.stderr = this.stderr;
      throw err;
    });

    // Boot succeeded, so from here an exit is news. The listener above has
    // already fired-or-not; this one owns the rest of the process's life.
    child.once("exit", (code, signal) => {
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
   * Stop the daemon AND everything it started.
   *
   * The daemon spawns the agent CLIs as its own children, so signalling only
   * the daemon leaves those running — invisible processes holding an API
   * session open after the user believes they quit.
   *
   * Unix: signal the process GROUP (the negative pid), which detached:true made
   * the daemon the leader of. SIGTERM first so it can close sockets, SIGKILL
   * after a grace period for anything ignoring it.
   * Windows: `taskkill /T` walks the process tree, which is the only reliable
   * way to do this there — Windows has no process groups in the Unix sense.
   */
  stop() {
    const child = this.#child;
    if (!child?.pid) return;
    this.#stopping = true;
    this.#child = null;

    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* group already gone */
    }
    const grace = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* exited during the grace period, as intended */
      }
    }, 4000);
    // Don't hold the app open waiting to escalate a kill that may not be needed.
    grace.unref?.();
    child.once("exit", () => clearTimeout(grace));
  }
}
