// Pins the 2026-08-03 bug: stop() during start()'s pre-spawn window (the
// login-shell PATH lookup, up to 5s) was a silent no-op — the daemon then
// spawned anyway, and nothing would ever kill it. A quit landing in that
// window orphaned the daemon past the app's exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CredentialSafeLineStream,
  Daemon,
  appendStderr,
  findStartupUrl,
  redactCredentials,
  terminateProcessTree,
} from "../src/daemon.js";

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
