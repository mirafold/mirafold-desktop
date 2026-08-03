// Pins the 2026-08-03 bug: stop() during start()'s pre-spawn window (the
// login-shell PATH lookup, up to 5s) was a silent no-op — the daemon then
// spawned anyway, and nothing would ever kill it. A quit landing in that
// window orphaned the daemon past the app's exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Daemon, appendStderr, redactTokens } from "../src/daemon.js";

test("stop() before the spawn prevents the daemon from starting", async () => {
  const daemon = new Daemon(() => {
    throw new Error("the crash callback must not fire for a pre-spawn stop");
  });
  const started = daemon.start(process.cwd());
  daemon.stop(); // lands while start() is still awaiting the login shell
  await assert.rejects(started, /stopped before the daemon was spawned/);
  assert.equal(daemon.running, false);
});

// Pins the 2026-08-03 audit finding: the daemon's per-launch auth token was
// mirrored verbatim to this app's own stdout, which a desktop launcher hands
// to the system journal, and kept in the crash dialog's text.
test("the auth token never leaves the process", () => {
  const line = "  ready → http://127.0.0.1:5173/?token=s3cr3t-abc123 (press ctrl-c)";
  const out = redactTokens(line);
  assert.ok(!out.includes("s3cr3t-abc123"), out);
  assert.ok(out.includes("token=<redacted>"), out);
  assert.ok(out.includes("http://127.0.0.1:5173/"), "the URL itself stays readable");

  assert.ok(!appendStderr([], line).join("\n").includes("s3cr3t-abc123"));
  assert.equal(redactTokens("nothing to redact here"), "nothing to redact here");
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
