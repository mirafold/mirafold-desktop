import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  packagedPaths,
  runPackagedNodeProbe,
} from "../scripts/packaged-smoke.mjs";

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture(t, { shellVersion = "0.3.7" } = {}) {
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
  }));
  writeFileSync(path.join(app, "src", "main.js"), "// fixture\n");
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
