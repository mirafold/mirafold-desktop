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

function runProbe(source) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "--eval", source],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
}

test("a failed startup preserves an unproved cleanup result for its lifecycle owner", () => {
  runProbe(STARTUP_CLEANUP_PROBE);
});

test("a ready Windows Job that closes before its daemon URL remains a proved cleanup", () => {
  runProbe(WINDOWS_READY_CLOSE_PROBE);
});

test("a live Linux boundary with no readable identity fails closed without being signalled", {
  skip: process.platform !== "linux",
}, () => {
  runProbe(UNREADABLE_IDENTITY_PROBE);
});
