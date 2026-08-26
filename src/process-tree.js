// Owning and stopping the daemon's complete process tree.
//
// The daemon starts the agent CLIs as its own children, so signalling only the
// daemon leaves those running — invisible processes holding an API session
// open after the user believes they quit. Every path that ends the daemon goes
// through terminateProcessTree(), which reports whether the tree is PROVEN
// gone; the updater must not start an installer while any process still has
// the old application files open.
//
// Unix: the daemon is spawned detached, so it leads its own process group and
// the negative pid signals the group. Linux additionally tracks per-process
// identity (pid + kernel start time) because pseudo-terminals start their
// foreground process in a new session and group, outside the daemon's own; a
// retained identity guards a later signal against a reused PID. On Windows,
// the wrapper owns the daemon in a kill-on-close Job Object (see
// windows-daemon-job.ps1). A private named event requests complete Job
// termination during an orderly stop; kill-on-close provides the same boundary
// after a crash, while `taskkill /T` remains the pre-ownership fallback.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const WINDOWS_STOP_EVENT_ENV = "MIRAFOLD_DESKTOP_WINDOWS_STOP_EVENT";

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
 * tracked identities above for separately grouped PTYs. The Windows fallback
 * uses `taskkill /T`; the ordinary post-start path uses the daemon's
 * kill-on-close Job Object instead.
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
 * @param {{termTimeoutMs?: number, killTimeoutMs?: number, ledgerFile?: string|null, windowsJobOwned?: boolean, windowsJobClosed?: Promise<unknown>|null, windowsStopEvent?: string|null, windowsEnv?: object|null}} timings
 *   bounded waits, the private Linux creation ledger, and whether a Windows
 *   leader owns its descendants through a kill-on-close Job Object; exposed so
 *   focused tests do not spend four seconds escalating
 * @returns {Promise<boolean>} true only after clean tree termination is proven
 */
export async function terminateProcessTree(pid, trackedIdentities = [], timings = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return true;

  if (process.platform === "win32") {
    if (timings.windowsJobOwned === true) {
      // The wrapper registered this event with a native callback after joining
      // its kill-on-close Job. Signal it from a short stock-PowerShell process;
      // the callback calls TerminateJobObject, which is an authoritative tree
      // boundary even when taskkill cannot traverse a hosted Electron tree.
      const stopEvent = timings.windowsStopEvent;
      if (typeof stopEvent !== "string" || !stopEvent.startsWith("Local\\MirafoldDesktopStop-")) {
        return false;
      }
      const systemRoot = timings.windowsEnv?.SystemRoot
        ?? timings.windowsEnv?.SYSTEMROOT
        ?? "C:\\Windows";
      const signaler = spawn(
        path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$event = [Threading.EventWaitHandle]::OpenExisting($env:MIRAFOLD_DESKTOP_WINDOWS_STOP_EVENT); try { if (-not $event.Set()) { exit 1 } } finally { $event.Dispose() }",
        ],
        {
          env: { ...timings.windowsEnv, [WINDOWS_STOP_EVENT_ENV]: stopEvent },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      signaler.once("error", () => {});
      const signaled = await new Promise((resolve) => {
        let settled = false;
        const finish = (clean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(clean);
        };
        const timeout = setTimeout(() => {
          signaler.kill();
          finish(false);
        }, 10_000);
        signaler.once("error", () => finish(false));
        signaler.once("close", (code) => finish(code === 0));
      });
      if (!signaled || !timings.windowsJobClosed) return false;
      // ChildProcess `close` is stronger than `exit`: Node emits it only after
      // the wrapper has exited and every inherited stdio handle is closed. The
      // packaged daemon inherits those handles, so this also prevents stop()
      // from racing the final loopback reachability check while Job teardown
      // is still completing.
      return Promise.race([
        timings.windowsJobClosed.then(() => true),
        delay(10_000).then(() => false),
      ]);
    }
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
