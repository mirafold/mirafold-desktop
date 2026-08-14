// Pins the 2026-08-03 bug: stop() during start()'s pre-spawn window (the
// login-shell PATH lookup, up to 5s) was a silent no-op — the daemon then
// spawned anyway, and nothing would ever kill it. A quit landing in that
// window orphaned the daemon past the app's exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CredentialSafeLineStream,
  Daemon,
  LinuxProcessTreeTracker,
  appendStderr,
  daemonLaunchSpec,
  findStartupUrl,
  redactCredentials,
  terminateProcessTree,
} from "../src/daemon.js";

const require = createRequire(import.meta.url);

function sanitizeChunks(chunks) {
  const stream = new CredentialSafeLineStream();
  let output = "";
  for (const chunk of chunks) output += stream.push(chunk);
  return output + stream.end();
}

test("stop() before the spawn prevents the daemon from starting", async () => {
  const daemon = new Daemon(() => {
    throw new Error("the crash callback must not fire for a pre-spawn stop");
  });
  const started = daemon.start(process.cwd());
  daemon.stop(); // lands while start() is still awaiting the login shell
  await assert.rejects(started, /stopped before the daemon was spawned/);
  assert.equal(daemon.running, false);
});

const CREDENTIAL_LINES = [
  {
    name: "auth token",
    secret: "dummy-auth-token-123",
    text: "ready http://127.0.0.1:5173/?token=dummy-auth-token-123 (ws at /ws)\n",
  },
  {
    name: "pairing code",
    secret: "dummy-pairing-code_456",
    text: "[relay] dialing wss://relay.invalid — pairing code: dummy-pairing-code_456\r\n",
  },
];

// Pins the 2026-08-13 audit findings: the pairing credential was not redacted
// at all, and a token split between two `data` chunks evaded the old per-chunk
// regular expression. Every split point must now produce the same safe line.
test("credentials are redacted across every possible stream boundary", () => {
  for (const { name, secret, text } of CREDENTIAL_LINES) {
    for (const input of [text, text.replace(/\r?\n$/, "")]) {
      const ending = input === text ? "terminated" : "unterminated";
      const expected = redactCredentials(input);
      assert.ok(!expected.includes(secret), `${name}: complete-line redaction failed`);

      for (let split = 0; split <= input.length; split++) {
        const output = sanitizeChunks([input.slice(0, split), input.slice(split)]);
        assert.equal(output, expected, `${name} ${ending}: split at character ${split}`);
        assert.ok(!output.includes(secret), `${name} ${ending}: secret survived split ${split}`);
      }

      assert.equal(
        sanitizeChunks([...input]),
        expected,
        `${name} ${ending}: one-character chunks must stay safe`,
      );
    }
  }
});

test("the complete startup URL stays private and usable inside the process", () => {
  const first = "[mirafold] server on http://127.0.0.1:5173/?token=dummy-start";
  const second = "up-token (ws at /ws)\n";
  const privateUrl = "http://127.0.0.1:5173/?token=dummy-startup-token";

  assert.equal(findStartupUrl(first), null, "a chunk ending mid-token is not a URL");
  assert.equal(findStartupUrl(first + second), privateUrl, "the internal URL retains its token");

  const publicOutput = sanitizeChunks([first, second]);
  assert.ok(!publicOutput.includes("dummy-startup-token"), publicOutput);
  assert.ok(publicOutput.includes("http://127.0.0.1:5173/?token=<redacted>"), publicOutput);
});

test("adjacent credentials are all redacted without changing ordinary text", () => {
  const input = [
    "first=http://127.0.0.1:3000/?token=first-secret&mode=1",
    "pairing code: second_secret",
    "last=http://127.0.0.1:3001/?token=third-secret",
  ].join(" | ") + "\n";
  const output = sanitizeChunks([input.slice(0, 7), input.slice(7, 53), input.slice(53)]);

  for (const secret of ["first-secret", "second_secret", "third-secret"]) {
    assert.ok(!output.includes(secret), secret);
  }
  assert.equal((output.match(/<redacted>/g) ?? []).length, 3, output);
  assert.ok(output.includes("first=http://127.0.0.1:3000/?token=<redacted>&mode=1"));
  assert.ok(output.includes(" | pairing code: <redacted> | last="));
});

test("incomplete and ordinary lines are withheld, flushed, and preserved", () => {
  const stream = new CredentialSafeLineStream();
  assert.equal(stream.push("ordinary one\npartial"), "ordinary one\n");
  assert.equal(stream.push(" ordinary two\r\nlast"), "partial ordinary two\r\n");
  assert.equal(stream.end(), "last");
  assert.equal(stream.end(), "", "ending twice emits nothing twice");
  assert.equal(stream.push("ignored after end\n"), "", "late stream data fails closed");
});

test("an overlong logical line is wholly elided", () => {
  const secret = "dummy-overlong-pairing-secret";
  const output = sanitizeChunks([`prefix pairing code: ${secret} ${"x".repeat(20_000)}\nnext\n`]);
  assert.equal(output, "[mirafold desktop] overlong daemon output line elided\nnext\n");
  assert.ok(!output.includes(secret));
});

test("the crash buffer receives only stream-sanitized credentials", () => {
  const stream = new CredentialSafeLineStream();
  let lines = [];
  const input = "failure http://127.0.0.1:3000/?token=dummy-crash-token pairing code: dummy-crash-code\n";
  for (const chunk of [...input]) lines = appendStderr(lines, stream.push(chunk));
  lines = appendStderr(lines, stream.end());
  const crashText = lines.join("\n");

  assert.ok(!crashText.includes("dummy-crash-token"), crashText);
  assert.ok(!crashText.includes("dummy-crash-code"), crashText);
  assert.equal((crashText.match(/<redacted>/g) ?? []).length, 2, crashText);
  assert.equal(redactCredentials("nothing to redact here"), "nothing to redact here");
});

// Pins the 2026-08-03 audit finding: the crash buffer capped line COUNT but not
// line LENGTH, so one enormous line was retained whole for the app's lifetime.
test("the crash buffer is bounded in both directions", () => {
  let lines = [];
  for (let i = 0; i < 500; i++) lines = appendStderr(lines, `line ${i}\n`);
  assert.equal(lines.length, 100, "line count capped");
  assert.equal(lines.at(-1), "line 499", "keeps the most recent");

  const huge = appendStderr([], "x".repeat(5_000_000));
  assert.equal(huge.length, 1);
  assert.ok(huge[0].length <= 1000, `line length capped, got ${huge[0].length}`);
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processIsRunning(pid) {
  if (process.platform !== "linux") return processExists(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

function linuxStartTime(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), message);
}

test("process-tree termination resolves only after the leader and its child are gone", async () => {
  const testDirectory = mkdtempSync(path.join(tmpdir(), "mirafold-process-tree-test-"));
  const readyFile = path.join(testDirectory, "ready");
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        'const { writeFileSync } = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'writeFileSync(process.argv[1], String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join(""),
      readyFile,
    ],
    {
      detached: process.platform !== "win32",
      stdio: "ignore",
    },
  );

  // terminateProcessTree deliberately unrefs its polling timers so an ordinary
  // app quit is never held open. Keep this isolated test process alive while
  // awaiting the same Promise an update installation awaits behind a window.
  const keepAlive = setInterval(() => {}, 1000);
  let grandchildPid = null;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(readyFile) && processExists(leader.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(readyFile), "child process did not report readiness");
    grandchildPid = Number(readFileSync(readyFile, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    assert.equal(await terminateProcessTree(leader.pid), true);
    assert.equal(processExists(leader.pid), false, "tree leader is gone when the Promise resolves");
    assert.equal(processExists(grandchildPid), false, "tree child is gone when the Promise resolves");
  } finally {
    clearInterval(keepAlive);
    if (processExists(leader.pid)) await terminateProcessTree(leader.pid);
    if (grandchildPid && processExists(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // It exited between the existence check and the cleanup signal.
      }
    }
    rmSync(testDirectory, { recursive: true, force: true });
  }
});

test(
  "process-tree termination escalates against a descendant in its own Linux session",
  { skip: process.platform !== "linux" },
  async () => {
    const testDirectory = mkdtempSync(path.join(tmpdir(), "mirafold-separate-session-test-"));
    const readyFile = path.join(testDirectory, "ready");
    const leader = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'const code = `const { writeFileSync } = require("node:fs");',
          '  process.on("SIGTERM", () => {});',
          '  writeFileSync(process.argv[1], String(process.pid));',
          "  setInterval(() => {}, 1000);`;",
          'spawn(process.execPath, ["-e", code, process.argv[1]],',
          '  { detached: true, stdio: "ignore" });',
          "setInterval(() => {}, 1000);",
        ].join(""),
        readyFile,
      ],
      { detached: true, stdio: "ignore" },
    );

    let descendantPid = null;
    try {
      await waitFor(() => existsSync(readyFile), "separate-session child did not report readiness");
      descendantPid = Number(readFileSync(readyFile, "utf8"));
      assert.ok(processExists(descendantPid));

      const startedAt = Date.now();
      assert.equal(
        await terminateProcessTree(leader.pid, [], { termTimeoutMs: 150, killTimeoutMs: 2000 }),
        true,
      );
      assert.ok(Date.now() - startedAt >= 125, "SIGKILL escalation was not exercised");
      assert.equal(processExists(leader.pid), false);
      assert.equal(processIsRunning(descendantPid), false, "separate-session descendant survived cleanup");
    } finally {
      if (processExists(leader.pid)) process.kill(leader.pid, "SIGKILL");
      if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
      rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "retained Linux identities clean up a separate-session descendant after its leader crashes",
  { skip: process.platform !== "linux" },
  async () => {
    const testDirectory = mkdtempSync(path.join(tmpdir(), "mirafold-crashed-tree-test-"));
    const readyFile = path.join(testDirectory, "ready");
    const leader = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { writeFileSync } = require("node:fs");',
          'const { spawn } = require("node:child_process");',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
          '  { detached: true, stdio: "ignore" });',
          'writeFileSync(process.argv[1], String(child.pid));',
          "setInterval(() => {}, 1000);",
        ].join(""),
        readyFile,
      ],
      { detached: true, stdio: "ignore" },
    );
    const tracker = new LinuxProcessTreeTracker(leader.pid, 10);

    let descendantPid = null;
    try {
      await waitFor(() => existsSync(readyFile), "tracked child did not report readiness");
      descendantPid = Number(readFileSync(readyFile, "utf8"));
      await waitFor(
        () => tracker.snapshot().some((identity) => identity.pid === descendantPid),
        "tracker did not retain the separate-session child",
      );

      process.kill(leader.pid, "SIGKILL");
      await once(leader, "close");
      assert.equal(processExists(descendantPid), true, "probe child did not survive its leader");

      assert.equal(
        await terminateProcessTree(leader.pid, tracker.stop(), {
          termTimeoutMs: 250,
          killTimeoutMs: 2000,
        }),
        true,
      );
      assert.equal(processIsRunning(descendantPid), false, "retained descendant survived crash cleanup");
    } finally {
      tracker.stop();
      if (processExists(leader.pid)) process.kill(leader.pid, "SIGKILL");
      if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
      rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "Linux termination ingests PTYs recorded after its initial snapshot",
  { skip: process.platform !== "linux" },
  async () => {
    const testDirectory = mkdtempSync(path.join(tmpdir(), "mirafold-live-ledger-test-"));
    const readyFile = path.join(testDirectory, "ready");
    const ledgerFile = path.join(testDirectory, "owned-processes");
    writeFileSync(ledgerFile, "", { mode: 0o600 });
    const leader = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'process.on("SIGTERM", () => {});',
          'const child = spawn(process.execPath, ["-e",',
          '  "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"],',
          '  { detached: true, stdio: "ignore" });',
          'writeFileSync(process.argv[1], String(child.pid));',
          'setInterval(() => {}, 1000);',
        ].join(""),
        readyFile,
      ],
      { detached: true, stdio: "ignore" },
    );

    let descendantPid = null;
    let recordTimer = null;
    try {
      await waitFor(() => existsSync(readyFile), "late-ledger child did not report readiness");
      descendantPid = Number(readFileSync(readyFile, "utf8"));
      const startTime = linuxStartTime(descendantPid);
      const startedAt = Date.now();
      const termination = terminateProcessTree(leader.pid, [], {
        termTimeoutMs: 200,
        killTimeoutMs: 2000,
        ledgerFile,
      });
      recordTimer = setTimeout(() => {
        writeFileSync(ledgerFile, `${descendantPid}:${startTime}\n`);
      }, 50);

      assert.equal(await termination, true);
      assert.ok(Date.now() - startedAt >= 175, "forced escalation was not exercised");
      assert.equal(processIsRunning(leader.pid), false);
      assert.equal(processIsRunning(descendantPid), false, "late ledger descendant survived cleanup");
    } finally {
      if (recordTimer) clearTimeout(recordTimer);
      if (processExists(leader.pid)) process.kill(leader.pid, "SIGKILL");
      if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
      rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test("Windows daemon launches inside the packaged kill-on-close Job Object wrapper", () => {
  const spec = daemonLaunchSpec({
    platform: "win32",
    executable: "C:\\Program Files\\Mirafold\\Mirafold.exe",
    bootstrapEntry: "C:\\Program Files\\Mirafold\\resources\\app\\src\\daemon-bootstrap.cjs",
    daemonEntry: "C:\\Program Files\\Mirafold\\resources\\app\\node_modules\\mirafold\\dist-server\\index.js",
    windowsJobEntry: "C:\\Program Files\\Mirafold\\resources\\app\\src\\windows-daemon-job.ps1",
    env: { SystemRoot: "C:\\Windows", PATH: "fixture-path" },
  });

  assert.equal(
    spec.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(spec.args, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "C:\\Program Files\\Mirafold\\resources\\app\\src\\windows-daemon-job.ps1",
    "C:\\Program Files\\Mirafold\\Mirafold.exe",
    "C:\\Program Files\\Mirafold\\resources\\app\\src\\daemon-bootstrap.cjs",
    "C:\\Program Files\\Mirafold\\resources\\app\\node_modules\\mirafold\\dist-server\\index.js",
  ]);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spec.detached, false);
});

test(
  "the bootstrap synchronously owns an immediate Linux PTY and scrubs Electron Node mode",
  { skip: process.platform !== "linux" },
  async () => {
    const testDirectory = mkdtempSync(path.join(tmpdir(), "mirafold-bootstrap-ownership-test-"));
    const ledgerFile = path.join(testDirectory, "owned-processes");
    const daemonReady = path.join(testDirectory, "daemon-ready.json");
    const ptyReady = path.join(testDirectory, "pty-ready.json");
    const fakeDaemon = path.join(testDirectory, "crashing-daemon.mjs");
    const ptyEntry = pathToFileURL(require.resolve("@lydell/node-pty")).href;
    const electronExecutable = require("electron");
    const childCode = [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGHUP", () => {});',
      'process.on("SIGTERM", () => {});',
      'writeFileSync(process.argv[1], JSON.stringify({',
      '  pid: process.pid,',
      '  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
      '  ledger: process.env.MIRAFOLD_DESKTOP_PID_LEDGER ?? null,',
      '}));',
      'setInterval(() => {}, 1000);',
    ].join("");
    writeFileSync(fakeDaemon, [
      `import { spawn } from ${JSON.stringify(ptyEntry)};`,
      'import { existsSync, writeFileSync } from "node:fs";',
      `const child = spawn(process.env.PROBE_NODE_EXECUTABLE, ["-e", ${JSON.stringify(childCode)}, process.env.PROBE_PTY_READY], {`,
      '  name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,',
      '});',
      'writeFileSync(process.env.PROBE_DAEMON_READY, JSON.stringify({',
      '  ptyPid: child.pid,',
      '  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
      '  ledger: process.env.MIRAFOLD_DESKTOP_PID_LEDGER ?? null,',
      '  electron: process.versions.electron ?? null,',
      '}));',
      'const deadline = Date.now() + 5000;',
      'while (!existsSync(process.env.PROBE_PTY_READY) && Date.now() < deadline) {',
      '  await new Promise((resolve) => setTimeout(resolve, 5));',
      '}',
      'if (!existsSync(process.env.PROBE_PTY_READY)) throw new Error("PTY child did not start");',
      'process.exit(23);',
      '',
    ].join("\n"));
    writeFileSync(ledgerFile, "", { mode: 0o600 });

    const leader = spawn(electronExecutable, [path.resolve("src/daemon-bootstrap.cjs"), fakeDaemon], {
      cwd: testDirectory,
      detached: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MIRAFOLD_DESKTOP_PID_LEDGER: ledgerFile,
        PROBE_DAEMON_READY: daemonReady,
        PROBE_NODE_EXECUTABLE: process.execPath,
        PROBE_PTY_READY: ptyReady,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const closed = once(leader, "close");
    const tracker = new LinuxProcessTreeTracker(leader.pid, 60_000, ledgerFile);
    let ptyPid = null;
    let stderr = "";
    leader.stderr.setEncoding("utf8");
    leader.stderr.on("data", (chunk) => { stderr += chunk; });

    try {
      await waitFor(() => existsSync(daemonReady), `bootstrap daemon did not report readiness: ${stderr}`);
      await waitFor(() => existsSync(ptyReady), `bootstrap PTY did not report readiness: ${stderr}`);
      const daemonReport = JSON.parse(readFileSync(daemonReady, "utf8"));
      const ptyReport = JSON.parse(readFileSync(ptyReady, "utf8"));
      ptyPid = daemonReport.ptyPid;
      assert.equal(ptyReport.pid, ptyPid);
      assert.equal(daemonReport.runAsNode, null);
      assert.equal(daemonReport.ledger, null);
      assert.equal(daemonReport.electron, "43.4.0");
      assert.equal(ptyReport.runAsNode, null);
      assert.equal(ptyReport.ledger, null);

      const [code] = await closed;
      assert.equal(code, 23, stderr);
      assert.equal(processIsRunning(ptyPid), true, "probe PTY did not survive the daemon crash");
      const identities = tracker.stop();
      assert.ok(identities.some((identity) => identity.pid === ptyPid), "ledger omitted the immediate PTY");
      assert.equal(
        await terminateProcessTree(leader.pid, identities, { termTimeoutMs: 100, killTimeoutMs: 2000 }),
        true,
      );
      assert.equal(processIsRunning(ptyPid), false, "ledger-owned PTY survived cleanup");
    } finally {
      tracker.stop();
      if (processExists(leader.pid)) process.kill(leader.pid, "SIGKILL");
      if (ptyPid && processExists(ptyPid)) process.kill(ptyPid, "SIGKILL");
      rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);
