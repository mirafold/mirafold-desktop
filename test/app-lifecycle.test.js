import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBeforeQuitHandler,
  createLifecycleCoordinator,
  LIFECYCLE_ACTION,
} from "../src/app-lifecycle.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("every ordered lifecycle pair has one owner and request-order completion", async () => {
  const kinds = Object.values(LIFECYCLE_ACTION);
  for (const firstKind of kinds) {
    for (const secondKind of kinds) {
      if (firstKind === secondKind) continue;
      const coordinator = createLifecycleCoordinator();
      const firstGate = deferred();
      const firstStarted = deferred();
      const events = [];
      let active = 0;
      let maximumActive = 0;

      const operation = (label, gate = null) => async ({ isClosing }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push(`${label}.start`);
        if (gate) {
          firstStarted.resolve();
          await gate.promise;
        }
        events.push(`${label}.${isClosing() ? "closing" : "open"}`);
        active -= 1;
        events.push(`${label}.end`);
        return label;
      };

      const first = firstKind === LIFECYCLE_ACTION.QUIT
        ? coordinator.close(firstKind, operation("first", firstGate))
        : coordinator.run(firstKind, operation("first", firstGate));
      await firstStarted.promise;
      assert.equal(coordinator.owner, firstKind, `${firstKind} did not own its active turn`);

      const second = secondKind === LIFECYCLE_ACTION.QUIT
        ? coordinator.close(secondKind, operation("second"))
        : coordinator.run(secondKind, operation("second"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(maximumActive, 1, `${firstKind} overlapped ${secondKind}`);
      assert.deepEqual(events, ["first.start"], `${secondKind} began before ${firstKind} settled`);

      firstGate.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(maximumActive, 1, `${firstKind}/${secondKind} had two owners`);
      if (firstKind === LIFECYCLE_ACTION.QUIT) {
        assert.equal(firstResult, "first");
        assert.equal(secondResult, undefined);
        assert.deepEqual(events, ["first.start", "first.closing", "first.end"]);
      } else {
        assert.equal(firstResult, "first");
        assert.equal(secondResult, "second");
        assert.deepEqual(events, [
          "first.start",
          secondKind === LIFECYCLE_ACTION.QUIT ? "first.closing" : "first.open",
          "first.end",
          "second.start",
          secondKind === LIFECYCLE_ACTION.QUIT ? "second.closing" : "second.open",
          "second.end",
        ]);
      }
      assert.equal(coordinator.owner, null);
    }
  }
});

test("duplicate actions share one Promise and a rejected owner cannot poison its successor", async () => {
  const coordinator = createLifecycleCoordinator();
  const gate = deferred();
  let duplicateRuns = 0;
  const first = coordinator.run("folder-change", async () => {
    duplicateRuns += 1;
    await gate.promise;
    throw new Error("fixture owner failure");
  }, { dedupeKey: "folder-change" });
  const duplicate = coordinator.run("folder-change", () => {
    duplicateRuns += 1;
  }, { dedupeKey: "folder-change" });
  assert.equal(first, duplicate);

  const successor = coordinator.run("daemon-crash", () => "recovered");
  gate.resolve();
  await assert.rejects(first, /fixture owner failure/);
  assert.equal(await successor, "recovered");
  assert.equal(duplicateRuns, 1);
});

test("the first close is the sole terminal owner and retires already queued work", async () => {
  const coordinator = createLifecycleCoordinator();
  const activeGate = deferred();
  const activeStarted = deferred();
  const events = [];
  const active = coordinator.run("activation-start", async ({ isClosing }) => {
    events.push("active.start");
    activeStarted.resolve();
    await activeGate.promise;
    events.push(isClosing() ? "active.retired" : "active.completed");
  });
  await activeStarted.promise;
  const queued = coordinator.run("activation-complete", () => events.push("queued.ran"));
  const quit = coordinator.close("quit", () => events.push("quit.ran"));
  const duplicateQuit = coordinator.close("other-terminal", () => events.push("wrong.ran"));
  assert.equal(quit, duplicateQuit);
  assert.equal(coordinator.closing, true);

  activeGate.resolve();
  await Promise.all([active, queued, quit]);
  assert.deepEqual(events, ["active.start", "active.retired", "quit.ran"]);
});

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
