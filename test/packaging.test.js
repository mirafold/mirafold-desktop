// Packaging must preserve the platform-specific N-API binaries selected by
// npm. electron-builder's generic native rebuild does not understand
// @parcel/watcher's wrapper/optional-package layout and otherwise tries to
// compile the wrapper package from source before any artifact is produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const builderConfig = readFileSync(
  new URL("../electron-builder.yml", import.meta.url),
  "utf8",
)
  .split("\r\n")
  .join("\n");
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const daemonBootstrapSource = readFileSync(
  new URL("../src/daemon-bootstrap.cjs", import.meta.url),
  "utf8",
);
const windowsJobSource = readFileSync(
  new URL("../src/windows-daemon-job.ps1", import.meta.url),
  "utf8",
);

test("electron-builder preserves npm-selected N-API binaries", () => {
  assert.match(builderConfig, /(?:^|\n)npmRebuild:\s*false(?:\n|$)/);
});

test("the updater protocol implementation is an exact runtime dependency", () => {
  assert.equal(packageMetadata.dependencies?.["electron-updater"], "6.8.9");
  assert.equal(packageMetadata.devDependencies?.["electron-updater"], undefined);
});

test("blockmap verification pins the builder's existing hash implementation for development only", () => {
  assert.equal(packageMetadata.devDependencies?.["@noble/hashes"], "2.3.0");
  assert.equal(packageMetadata.dependencies?.["@noble/hashes"], undefined);
});

test("packaged update metadata targets only Mirafold's public stable GitHub channel", () => {
  assert.match(
    builderConfig,
    /(?:^|\n)publish:\s*\n\s+- provider: github\s*\n\s+owner: mirafold\s*\n\s+repo: mirafold-desktop\s*\n\s+channel: latest\s*\n\s+private: false\s*\n\s+publishAutoUpdate: true(?:\n|$)/,
  );
  assert.match(builderConfig, /(?:^|\n)generateUpdatesFilesForAllChannels:\s*false(?:\n|$)/);
  assert.doesNotMatch(builderConfig, /(?:^|\n)\s*token:/, "a client update credential must never be packaged");
});

test("the packaged runtime wires Linux form detection and guarded platform updaters", () => {
  for (const required of [
    "desktopUpdateStrategy({",
    "process.env.APPIMAGE",
    'path.join(process.resourcesPath, "package-type")',
    'updateStrategy === "manual-download"',
    "new AppUpdater()",
    "createSafeAppImageUpdater(AppImageUpdater",
    "createSafeNsisUpdater(NsisUpdater",
  ]) {
    assert.ok(mainSource.includes(required), `main-process update wiring omits ${required}`);
  }
});

test("both native wrappers load their installed platform packages", () => {
  const pty = require("@lydell/node-pty");
  const watcher = require("@parcel/watcher");

  assert.equal(typeof pty.spawn, "function");
  assert.equal(typeof watcher.subscribe, "function");
});

test("packaging carries the daemon bootstrap and Windows kill-on-close wrapper", () => {
  assert.match(builderConfig, /(?:^|\n)files:\s*\n\s+- src\/\*\*\/\*(?:\n|$)/);
  const deleteNodeMode = daemonBootstrapSource.indexOf("delete process.env.ELECTRON_RUN_AS_NODE");
  const importDaemon = daemonBootstrapSource.indexOf("await import(");
  assert.ok(deleteNodeMode !== -1 && deleteNodeMode < importDaemon);

  for (const required of [
    "CreateJobObject",
    "SetInformationJobObject",
    "AssignProcessToJobObject",
    "TerminateJobObject",
    "JobStopRegistration",
    "CreateProcess",
    "CREATE_SUSPENDED",
    "IsProcessInJob",
    "JobObjectProcessLauncher",
    "MIRAFOLD_DESKTOP_WINDOWS_STOP_EVENT",
    "0x00002000",
  ]) {
    assert.ok(windowsJobSource.includes(required), `Windows Job Object wrapper omits ${required}`);
  }
  assert.ok(
    windowsJobSource.indexOf("AssignProcessToJobObject") < windowsJobSource.lastIndexOf("JobObjectProcessLauncher]::Run"),
    "the wrapper must establish Job assignment before resuming Electron",
  );
});

test("Linux desktop filename and runtime window identity stay synchronized", () => {
  assert.equal(packageMetadata.desktopName, "mirafold.desktop");
  assert.match(builderConfig, /(?:^|\n)\s*syncDesktopName:\s*true(?:\n|$)/);
});

test("the AppImage desktop entry does not disable Chromium's sandbox unconditionally", () => {
  assert.match(builderConfig, /(?:^|\n)appImage:\s*\n\s+executableArgs:\s*\[\](?:\n|$)/);
});
