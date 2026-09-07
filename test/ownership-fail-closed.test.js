import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const STARTUP_CLEANUP_PROBE = String.raw`
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { mock } from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(process, "platform", { value: "linux" });

let cleanupCalls = 0;

class FakeStream extends EventEmitter {
  setEncoding() {}
}

class FakeInput extends EventEmitter {
  end(...args) {
    const completed = args.at(-1);
    queueMicrotask(() => completed(new Error("fixture handoff failure")));
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 424242;
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = new FakeInput();
  }
}

mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    spawn() {
      const child = new FakeChild();
      setImmediate(() => child.stdout.emit(
        "data",
        "Mirafold is running at http://127.0.0.1:4123/?token=fixture \\n",
      ));
      return child;
    },
  },
});
mock.module(new URL("./src/process-tree.js", import.meta.url).href, {
  namedExports: {
    LinuxProcessTreeTracker: class {
      stop() { return [{ pid: 424242, startTime: "fixture" }]; }
    },
    async terminateProcessTree() {
      cleanupCalls += 1;
      return false;
    },
  },
});

const { Daemon } = await import(new URL("./src/daemon.js?startup-cleanup-proof", import.meta.url));
const daemon = new Daemon(undefined, {
  loadEnv: async () => ({}),
  resolveDaemonEntry: () => "/fixture/daemon.mjs",
  writeStdout() {},
  writeStderr() {},
});

await assert.rejects(
  daemon.start("/tmp"),
  (error) => error?.code === "desktop-credential-handoff",
);
assert.equal(cleanupCalls, 1, "startup attempted one process-tree cleanup");
assert.equal(
  await daemon.stop(),
  false,
  "stop must preserve the startup cleanup's unproved result",
);
process.stdout.write("startup cleanup proof passed\n");
`;

const WINDOWS_READY_CLOSE_PROBE = String.raw`
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { mock } from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(process, "platform", { value: "win32" });
let cleanupCalls = 0;

class FakeStream extends EventEmitter {
  setEncoding() {}
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 424242;
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = null;
  }
}

mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    spawn() {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit("data", "MIRAFOLD_DESKTOP_WINDOWS_WRAPPER_READY\r\n");
        setImmediate(() => child.emit("close", 1, null));
      });
      return child;
    },
  },
});
mock.module(new URL("./src/process-tree.js", import.meta.url).href, {
  namedExports: {
    LinuxProcessTreeTracker: class { stop() { return []; } },
    async terminateProcessTree() {
      cleanupCalls += 1;
      return false;
    },
  },
});

const { Daemon } = await import(new URL(
  "./src/daemon.js?windows-ready-close-proof",
  import.meta.url,
));
const daemon = new Daemon(undefined, {
  loadEnv: async () => ({ SystemRoot: "C:\\\\Windows" }),
  resolveDaemonEntry: () => "C:\\\\fixture\\\\daemon.mjs",
  writeStdout() {},
  writeStderr() {},
});

await assert.rejects(daemon.start("C:\\\\fixture"), /before starting/);
assert.equal(cleanupCalls, 0, "an already-closed Job fell through to taskkill");
assert.equal(
  await daemon.stop(),
  true,
  "the completed Windows Job boundary was not preserved as clean",
);
process.stdout.write("Windows ready-close proof passed\n");
`;

const WINDOWS_LATE_CLOSE_PROBE = String.raw`
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { mock } from "node:test";
import assert from "node:assert/strict";

const mode = process.argv[1];
assert.ok(mode === "startup" || mode === "stop");
Object.defineProperty(process, "platform", { value: "win32" });

class FakeStream extends EventEmitter {
  setEncoding() {}
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 424242;
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = null;
  }
}

let wrapper;
let stopRequests = 0;
mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    spawn(_command, args) {
      if (args.includes("-File")) {
        wrapper = new FakeChild();
        setImmediate(() => {
          wrapper.stdout.emit("data", "MIRAFOLD_DESKTOP_WINDOWS_WRAPPER_READY\r\n");
          setImmediate(() => {
            if (mode === "startup") {
              wrapper.emit("error", new Error("fixture startup failure"));
            } else {
              wrapper.stdout.emit(
                "data",
                "Mirafold is running at http://127.0.0.1:4123/?token=fixture \r\n",
              );
            }
          });
        });
        return wrapper;
      }

      assert.ok(args.includes("-Command"), "unexpected child process");
      stopRequests += 1;
      const signaler = new EventEmitter();
      signaler.kill = () => {};
      setImmediate(() => {
        // The named event disappeared before OpenExisting could use it, but
        // wrapper close still proves the kill-on-close Job boundary shortly
        // afterward.
        signaler.emit("close", 1);
        setTimeout(() => wrapper.emit("close", 0, null), 20);
      });
      return signaler;
    },
  },
});

const { Daemon } = await import(new URL(
  "./src/daemon.js?windows-late-close-" + mode,
  import.meta.url,
));
const daemon = new Daemon(undefined, {
  loadEnv: async () => ({ SystemRoot: "C:\\\\Windows" }),
  resolveDaemonEntry: () => "C:\\\\fixture\\\\daemon.mjs",
  writeStdout() {},
  writeStderr() {},
});

if (mode === "startup") {
  await assert.rejects(daemon.start("C:\\\\fixture"), /fixture startup failure/);
} else {
  await daemon.start("C:\\\\fixture");
}

const firstClean = await daemon.stop();
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(firstClean, true, mode + " ignored the later Job close proof");
assert.equal(await daemon.stop(), true, mode + " cached an unproved cleanup result");
assert.equal(stopRequests, 1);
process.stdout.write("Windows late-close " + mode + " proof passed\n");
`;

const WINDOWS_UNPROVED_JOB_PROBE = String.raw`
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { mock } from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(process, "platform", { value: "win32" });
mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    spawn() {
      const signaler = new EventEmitter();
      signaler.kill = () => {};
      setImmediate(() => signaler.emit("close", 1));
      return signaler;
    },
  },
});

const { terminateProcessTree } = await import(new URL(
  "./src/process-tree.js?windows-unproved-job",
  import.meta.url,
));
assert.equal(
  await terminateProcessTree(424242, [], {
    killTimeoutMs: 0,
    windowsJobOwned: true,
    windowsJobClosed: new Promise(() => {}),
    windowsStopEvent: "Local\\MirafoldDesktopStop-fixture",
    windowsEnv: { SystemRoot: "C:\\Windows" },
  }),
  false,
  "cleanup without a successful stop request or wrapper close cannot be proved",
);
process.stdout.write("Windows unproved Job cleanup failed closed\n");
`;

const WINDOWS_REJECTED_JOB_PROBE = String.raw`
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { mock } from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(process, "platform", { value: "win32" });
mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    spawn() {
      const signaler = new EventEmitter();
      signaler.kill = () => {};
      setTimeout(() => signaler.emit("close", 1), 20);
      return signaler;
    },
  },
});

const { terminateProcessTree } = await import(new URL(
  "./src/process-tree.js?windows-rejected-job",
  import.meta.url,
));
assert.equal(
  await terminateProcessTree(424242, [], {
    killTimeoutMs: 100,
    windowsJobOwned: true,
    windowsJobClosed: Promise.reject(new Error("fixture rejected close proof")),
    windowsStopEvent: "Local\\MirafoldDesktopStop-fixture",
    windowsEnv: { SystemRoot: "C:\\Windows" },
  }),
  false,
  "a rejected wrapper-close boundary cannot prove cleanup",
);
process.stdout.write("Windows rejected Job close failed closed\n");
`;

const WINDOWS_SHARED_DEADLINE_PROBE = String.raw`
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import assert from "node:assert/strict";

Object.defineProperty(process, "platform", { value: "win32" });
let spawnCalls = 0;
mock.module("node:child_process", {
  namedExports: {
    ...realChildProcess,
    spawn() {
      spawnCalls += 1;
      const signaler = new EventEmitter();
      signaler.kill = () => {};
      if (spawnCalls === 2) {
        setTimeout(() => signaler.emit("close", 1), 100);
      }
      return signaler;
    },
  },
});

const { terminateProcessTree } = await import(new URL(
  "./src/process-tree.js?windows-shared-deadline",
  import.meta.url,
));
let started = performance.now();
assert.equal(
  await terminateProcessTree(424242, [], {
    killTimeoutMs: 250,
    windowsJobOwned: true,
    windowsJobClosed: new Promise((resolve) => setTimeout(resolve, 20)),
    windowsStopEvent: "Local\\MirafoldDesktopStop-early-close",
    windowsEnv: { SystemRoot: "C:\\Windows" },
  }),
  true,
);
const earlyCloseElapsed = performance.now() - started;
assert.ok(
  earlyCloseElapsed < 150,
  "proved Job close waited for the hung stop-event helper",
);

started = performance.now();
assert.equal(
  await terminateProcessTree(424243, [], {
    killTimeoutMs: 150,
    windowsJobOwned: true,
    windowsJobClosed: new Promise((resolve) => setTimeout(resolve, 220)),
    windowsStopEvent: "Local\\MirafoldDesktopStop-shared-deadline",
    windowsEnv: { SystemRoot: "C:\\Windows" },
  }),
  false,
  "sequential helper and close waits exceeded the shared cleanup deadline",
);
const sharedDeadlineElapsed = performance.now() - started;
assert.ok(sharedDeadlineElapsed < 200, "Windows Job cleanup exceeded its shared deadline");
process.stdout.write("Windows Job cleanup used one shared deadline\n");
`;

const UNREADABLE_IDENTITY_PROBE = String.raw`
import * as realFs from "node:fs";
import { mock } from "node:test";
import assert from "node:assert/strict";

const { default: realFsDefault, ...realFsNamed } = realFs;
mock.module("node:fs", {
  defaultExport: realFsDefault,
  namedExports: {
    ...realFsNamed,
    readFileSync(file, ...args) {
      if (String(file).startsWith("/proc/424242/")) {
        const error = new Error("fixture /proc denial");
        error.code = "EACCES";
        throw error;
      }
      return realFs.readFileSync(file, ...args);
    },
  },
});

const originalKill = process.kill;
const signals = [];
process.kill = (pid, signal) => {
  if (pid === 424242 || pid === -424242) {
    signals.push([pid, signal]);
    return true;
  }
  return originalKill(pid, signal);
};

try {
  const { terminateProcessTree } = await import(
    new URL("./src/process-tree.js?unreadable-identity-proof", import.meta.url)
  );
  assert.equal(
    await terminateProcessTree(424242, [], { termTimeoutMs: 0, killTimeoutMs: 0 }),
    false,
    "a live leader with an unreadable identity cannot be reported as proven gone",
  );
  assert.ok(signals.length > 0, "the live boundary was not checked");
  assert.ok(
    signals.every(([, signal]) => signal === 0),
    "an unidentified process or group must never be signalled",
  );
} finally {
  process.kill = originalKill;
}
process.stdout.write("unreadable identity proof passed\n");
`;

function runProbe(source, args = []) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "--eval", source, ...args],
    { cwd: ROOT, encoding: "utf8", timeout: 8_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
}

test("a failed startup preserves an unproved cleanup result for its lifecycle owner", () => {
  runProbe(STARTUP_CLEANUP_PROBE);
});

test("a ready Windows Job that closes before its daemon URL remains a proved cleanup", () => {
  runProbe(WINDOWS_READY_CLOSE_PROBE);
});

test("failed startup consumes a Windows Job close that follows a failed stop request", () => {
  runProbe(WINDOWS_LATE_CLOSE_PROBE, ["startup"]);
});

test("ordinary stop consumes a Windows Job close that follows a failed stop request", () => {
  runProbe(WINDOWS_LATE_CLOSE_PROBE, ["stop"]);
});

test("a failed Windows Job stop request without wrapper close remains unproved", () => {
  runProbe(WINDOWS_UNPROVED_JOB_PROBE);
});

test("a Windows Job close rejection fails closed even before the stop request settles", () => {
  runProbe(WINDOWS_REJECTED_JOB_PROBE);
});

test("Windows Job close and stop-event settlement share one cleanup deadline", () => {
  runProbe(WINDOWS_SHARED_DEADLINE_PROBE);
});

test("a live Linux boundary with no readable identity fails closed without being signalled", {
  skip: process.platform !== "linux",
}, () => {
  runProbe(UNREADABLE_IDENTITY_PROBE);
});
