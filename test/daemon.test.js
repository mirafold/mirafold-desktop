// Pins the 2026-08-03 bug: stop() during start()'s pre-spawn window (the
// login-shell PATH lookup, up to 5s) was a silent no-op — the daemon then
// spawned anyway, and nothing would ever kill it. A quit landing in that
// window orphaned the daemon past the app's exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Daemon } from "../src/daemon.js";

test("stop() before the spawn prevents the daemon from starting", async () => {
  const daemon = new Daemon(() => {
    throw new Error("the crash callback must not fire for a pre-spawn stop");
  });
  const started = daemon.start(process.cwd());
  daemon.stop(); // lands while start() is still awaiting the login shell
  await assert.rejects(started, /stopped before the daemon was spawned/);
  assert.equal(daemon.running, false);
});
