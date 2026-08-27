import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  packagedPaths,
  runPackagedDaemonProbe,
  runPackagedNodeProbe,
} from "../scripts/packaged-smoke.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function daemonSmokeText() {
  return `MIRAFOLD_PACKAGED_DAEMON_SMOKE=${JSON.stringify({
    urlContract: {
      protocol: "http:",
      hostname: "127.0.0.1",
      port: 3000,
      pathname: "/",
      queryKeys: ["token"],
      tokenPresent: true,
    },
    authenticationRedirectStatus: 302,
    authenticationCookieHardened: true,
    reachableStatus: 200,
    htmlServed: true,
    processTreeStopped: true,
    unreachableAfterStop: true,
    crashReported: false,
    windowsCrashTreeStopped: true,
  })}\n`;
}

function fixture(t, { daemonSource = null, shellVersion = "0.3.7" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-packaged-smoke-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "resources", "app");
  mkdirSync(path.join(app, "src"), { recursive: true });
  mkdirSync(path.join(app, "node_modules", "mirafold", "dist-server"), { recursive: true });
  mkdirSync(path.join(app, "node_modules", "@lydell", "node-pty"), { recursive: true });
  mkdirSync(path.join(app, "node_modules", "@parcel", "watcher"), { recursive: true });
  writeFileSync(path.join(app, "package.json"), jsonText({
    name: "mirafold-desktop-fixture",
    version: "1.2.3",
    main: "src/main.js",
    type: "module",
  }));
  writeFileSync(path.join(app, "src", "main.js"), "// fixture\n");
  writeFileSync(path.join(app, "src", "daemon.js"), daemonSource ?? `
import http from "node:http";

export class Daemon {
  #server = null;

  constructor(onCrash) {
    this.onCrash = onCrash;
  }

  get running() {
    return this.#server !== null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.#server = http.createServer((request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (url.searchParams.get("token") === "fixture-secret") {
          response.statusCode = 302;
          response.setHeader("location", "/");
          response.setHeader("set-cookie", "mirafold_token=fixture-secret; Path=/; HttpOnly; SameSite=Strict");
          response.end("Found");
          return;
        }
        if (request.headers.cookie !== "mirafold_token=fixture-secret") {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end("<!doctype html><title>fixture</title>");
      });
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        const address = this.#server.address();
        resolve("http://127.0.0.1:" + address.port + "/?token=fixture-secret");
      });
    });
  }

  stop() {
    const server = this.#server;
    this.#server = null;
    if (!server) return Promise.resolve(true);
    return new Promise((resolve) => server.close((error) => resolve(!error)));
  }
}
`);
  writeFileSync(path.join(app, "node_modules", "mirafold", "package.json"), jsonText({
    name: "mirafold",
    version: shellVersion,
  }));
  writeFileSync(path.join(app, "node_modules", "mirafold", "dist-server", "index.js"), "// fixture\n");
  writeFileSync(path.join(app, "node_modules", "@lydell", "node-pty", "package.json"), jsonText({
    name: "@lydell/node-pty",
    version: "1.0.0",
    main: "index.js",
  }));
  writeFileSync(path.join(app, "node_modules", "@lydell", "node-pty", "index.js"), "exports.spawn = () => {};\n");
  writeFileSync(path.join(app, "node_modules", "@parcel", "watcher", "package.json"), jsonText({
    name: "@parcel/watcher",
    version: "1.0.0",
    main: "index.js",
  }));
  writeFileSync(path.join(app, "node_modules", "@parcel", "watcher", "index.js"), "exports.subscribe = () => {};\n");
  return { root, app };
}

test("the packaged runtime resolves the daemon and loads both platform wrappers", (t) => {
  const { app } = fixture(t);
  assert.deepEqual(runPackagedNodeProbe({
    executable: process.execPath,
    appDirectory: app,
    expectedDesktopVersion: "1.2.3",
    expectedShellVersion: "0.3.7",
  }), {
    desktopVersion: "1.2.3",
    shellVersion: "0.3.7",
    daemonEntry: "node_modules/mirafold/dist-server/index.js",
    nodePtyLoaded: true,
    watcherLoaded: true,
  });
});

test("the smoke check refuses a packaged Shell other than the reviewed pin", (t) => {
  const { app } = fixture(t, { shellVersion: "0.3.8" });
  assert.throws(
    () => runPackagedNodeProbe({
      executable: process.execPath,
      appDirectory: app,
      expectedDesktopVersion: "1.2.3",
      expectedShellVersion: "0.3.7",
    }),
    /packaged Shell 0\.3\.8 != 0\.3\.7/,
  );
});

test("the packaged runtime starts, reaches, and completely stops its daemon", (t) => {
  const { root, app } = fixture(t);
  const report = runPackagedDaemonProbe({
    executable: process.execPath,
    appDirectory: app,
    temporaryDirectory: root,
  });
  assert.equal(report.urlContract.protocol, "http:");
  assert.equal(report.urlContract.hostname, "127.0.0.1");
  assert.ok(Number.isInteger(report.urlContract.port) && report.urlContract.port > 0);
  assert.equal(report.urlContract.pathname, "/");
  assert.deepEqual(report.urlContract.queryKeys, ["token"]);
  assert.equal(report.urlContract.tokenPresent, true);
  assert.equal(report.authenticationRedirectStatus, 302);
  assert.equal(report.authenticationCookieHardened, true);
  assert.equal(report.reachableStatus, 200);
  assert.equal(report.htmlServed, true);
  assert.equal(report.processTreeStopped, true);
  assert.equal(report.unreachableAfterStop, true);
  assert.equal(report.crashReported, false);
  // Null on every host: the fixture is not the real Mirafold.exe, so the
  // Windows Job-Object crash-ownership proof is deliberately out of scope here
  // (2026-08-14: the first native Windows CI run failed when the child probe
  // keyed on the platform alone and demanded surfaces the fixture lacks).
  assert.equal(report.windowsCrashTreeStopped, null);
});

test("the packaged daemon smoke rejects credential-bearing diagnostics", (t) => {
  const { root, app } = fixture(t);
  assert.throws(
    () => runPackagedDaemonProbe({
      executable: process.execPath,
      appDirectory: app,
      temporaryDirectory: root,
      spawn: () => ({
        error: null,
        signal: null,
        status: 0,
        stderr: "",
        stdout: "[mirafold] server on http://127.0.0.1:3000/?token=not-redacted\n",
      }),
    }),
    /exposed a daemon auth token/,
  );
});

test("a packaged daemon timeout preserves the inner diagnostic", (t) => {
  const { root, app } = fixture(t);
  assert.throws(
    () => runPackagedDaemonProbe({
      executable: process.execPath,
      appDirectory: app,
      temporaryDirectory: root,
      spawn: () => ({
        error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
        signal: "SIGTERM",
        status: null,
        stderr: "inner Windows crash probe failed\n",
        stdout: "",
      }),
    }),
    /spawnSync ETIMEDOUT: inner Windows crash probe failed/,
  );
});

test("a packaged daemon failure preserves safe startup stages and inner stderr", (t) => {
  const { root, app } = fixture(t, {
    daemonSource: `
export class Daemon {
  get running() { return false; }
  start() {
    process.stdout.write("[mirafold-probe-stage] bootstrap:shell-import-starting:12ms\\n");
    const error = new Error("fixture daemon boot failed");
    error.stderr = "inner diagnostic ?token=fixture-secret";
    return Promise.reject(error);
  }
  stop() { return Promise.resolve(true); }
}
`,
  });

  assert.throws(
    () => runPackagedDaemonProbe({
      executable: process.execPath,
      appDirectory: app,
      temporaryDirectory: root,
    }),
    (error) => {
      assert.match(error.message, /fixture daemon boot failed/);
      assert.match(error.message, /\[daemon stderr\]/);
      assert.match(error.message, /inner diagnostic \?token=<redacted>/);
      assert.match(error.message, /\[stdout\]/);
      assert.match(error.message, /bootstrap:shell-import-starting:12ms/);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    },
  );
});

test("the Windows packaged daemon smoke uses native tasklist and proves no Mirafold image remains", (t) => {
  const { root, app } = fixture(t);
  const executable = path.join(root, "Mirafold.exe");
  writeFileSync(executable, "fixture\n");
  const calls = [];
  const result = runPackagedDaemonProbe({
    executable,
    appDirectory: app,
    platform: "windows",
    temporaryDirectory: root,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        return { error: null, signal: null, status: 0, stderr: "", stdout: daemonSmokeText() };
      }
      return {
        error: null,
        signal: null,
        status: 0,
        stderr: "",
        stdout: "INFO: No tasks are running which match the specified criteria.\r\n",
      };
    },
  });

  assert.equal(result.executableProcessesAfterProbe, 0);
  assert.equal(result.windowsCrashTreeStopped, true);
  assert.equal(
    calls[0].options.env.MIRAFOLD_PROBE_CRASH_OWNERSHIP,
    "1",
    "the real Windows package must be told to prove Job-Object crash ownership",
  );
  assert.equal(
    calls[0].options.env.MIRAFOLD_PROBE_DIAGNOSTICS,
    "1",
    "the native Windows probe must retain opt-in startup diagnostics",
  );
  assert.equal(calls[1].command, "tasklist.exe");
  assert.deepEqual(calls[1].args, ["/FI", "IMAGENAME eq Mirafold.exe", "/FO", "CSV", "/NH"]);
});

test("the Windows packaged daemon smoke rejects a remaining Mirafold image", (t) => {
  const { root, app } = fixture(t);
  const executable = path.join(root, "Mirafold.exe");
  writeFileSync(executable, "fixture\n");
  let call = 0;
  assert.throws(
    () => runPackagedDaemonProbe({
      executable,
      appDirectory: app,
      platform: "windows",
      temporaryDirectory: root,
      spawn() {
        call += 1;
        return call === 1
          ? { error: null, signal: null, status: 0, stderr: "", stdout: daemonSmokeText() }
          : {
              error: null,
              signal: null,
              status: 0,
              stderr: "",
              stdout: '"Mirafold.exe","123","Console","1","42,000 K"\r\n',
            };
      },
    }),
    /1 packaged Mirafold processes remained/,
  );
});

test("the native Windows runner proves ConPTY and Job-Object crash ownership", {
  skip: process.platform !== "win32",
  timeout: 150_000,
}, (t) => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "mirafold-native-windows-smoke-"));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const executable = path.join(temporaryDirectory, "Mirafold.exe");
  copyFileSync(process.execPath, executable);

  const report = runPackagedDaemonProbe({
    executable,
    appDirectory: ROOT,
    platform: "windows",
    temporaryDirectory,
  });
  assert.equal(report.windowsCrashTreeStopped, true);
  assert.equal(report.executableProcessesAfterProbe, 0);
});

test("native build output paths are exact for Linux and Windows", () => {
  const outputDirectory = path.resolve("fixture-dist");
  assert.deepEqual(packagedPaths("linux", outputDirectory), {
    executable: path.join(outputDirectory, "linux-unpacked", "mirafold"),
    appDirectory: path.join(outputDirectory, "linux-unpacked", "resources", "app"),
  });
  assert.deepEqual(packagedPaths("windows", outputDirectory), {
    executable: path.join(outputDirectory, "win-unpacked", "Mirafold.exe"),
    appDirectory: path.join(outputDirectory, "win-unpacked", "resources", "app"),
  });
  assert.throws(() => packagedPaths("darwin", outputDirectory), /unsupported smoke platform/);
});
