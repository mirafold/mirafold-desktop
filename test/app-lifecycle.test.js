import { test } from "node:test";
import assert from "node:assert/strict";
import { createBeforeQuitHandler } from "../src/app-lifecycle.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("ordinary quit is held until one shared asynchronous cleanup completes", async () => {
  const cleanup = deferred();
  const lifecycle = [];
  let prevented = 0;
  const handler = createBeforeQuitHandler({
    beginQuit: () => lifecycle.push("begin"),
    stop: () => {
      lifecycle.push("stop");
      return cleanup.promise;
    },
    finishQuit: () => lifecycle.push("finish"),
  });
  const event = { preventDefault: () => (prevented += 1) };

  const first = handler(event);
  const second = handler(event);
  assert.equal(first, second, "re-entrant quit must share the cleanup Promise");
  assert.equal(prevented, 2, "every quit request is held while cleanup is pending");
  assert.deepEqual(lifecycle, ["begin", "stop"]);

  cleanup.resolve(true);
  await first;
  assert.deepEqual(lifecycle, ["begin", "stop", "finish"]);

  handler(event);
  assert.equal(prevented, 2, "the second Electron quit event is released");
  assert.deepEqual(lifecycle, ["begin", "stop", "finish"]);
});

test("a cleanup error is reported before the bounded quit is released", async () => {
  const failure = new Error("cleanup failed");
  const lifecycle = [];
  const handler = createBeforeQuitHandler({
    beginQuit: () => lifecycle.push("begin"),
    stop: async () => {
      lifecycle.push("stop");
      throw failure;
    },
    reportError: (error) => {
      lifecycle.push(["error", error]);
      throw new Error("diagnostic sink failed too");
    },
    finishQuit: () => lifecycle.push("finish"),
  });

  await handler({ preventDefault: () => lifecycle.push("prevent") });
  assert.deepEqual(lifecycle, ["prevent", "begin", "stop", ["error", failure], "finish"]);
});
