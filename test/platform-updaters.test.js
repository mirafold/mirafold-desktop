import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSafeAppImageUpdater, createSafeNsisUpdater } from "../src/platform-updaters.js";

const require = createRequire(import.meta.url);
const { AppImageUpdater, AppUpdater, NsisUpdater } = require("electron-updater");
const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

// The tar-archive strategy constructs the real package's AppUpdater directly
// (src/main.js loadAutoUpdater). A dependency bump that reshapes that export
// would otherwise go green in CI and fail silently on users' machines, since
// background update-check failures are deliberately non-fatal and quiet.
test("the real electron-updater still exports the tar-strategy AppUpdater", () => {
  assert.equal(typeof AppUpdater, "function");
  assert.equal(typeof AppUpdater.prototype.checkForUpdates, "function");
});

function appAdapter(version = "1.0.0") {
  const state = { quitCalls: 0 };
  return {
    state,
    adapter: {
      version,
      quit: () => (state.quitCalls += 1),
      onQuit: () => {},
    },
  };
}

function downloaded(updater, file, downloadedFileInfo = {}) {
  updater.downloadedUpdateHelper = { file, downloadedFileInfo };
  updater.logger = QUIET_LOGGER;
  return updater;
}

async function withAppImage(currentFile, action) {
  const previous = process.env.APPIMAGE;
  process.env.APPIMAGE = currentFile;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
  }
}

test("the installed AppImage updater preserves the current executable when its cache file is missing", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-appimage-missing-test-"));
  const currentFile = path.join(root, "Mirafold-1.0.0.AppImage");
  const missingInstaller = path.join(root, "cache", "Mirafold-1.1.0.AppImage");
  writeFileSync(currentFile, "working-version");
  const { adapter, state } = appAdapter();
  let beforeQuit = 0;
  const SafeAppImageUpdater = createSafeAppImageUpdater(AppImageUpdater, {
    emitBeforeQuit: () => (beforeQuit += 1),
  });
  const updater = downloaded(new SafeAppImageUpdater(null, adapter), missingInstaller);
  const errors = [];
  updater.on("error", (error) => errors.push(error));

  try {
    const result = await withAppImage(currentFile, () => updater.quitAndInstall(false, true));
    assert.equal(result, false);
    assert.equal(readFileSync(currentFile, "utf8"), "working-version");
    assert.equal(state.quitCalls, 0);
    assert.equal(beforeQuit, 0);
    assert.equal(errors.length, 1);
    assert.equal(
      existsSync(path.join(root, "Mirafold-1.1.0.AppImage")),
      false,
      "a failed copy must not create a partial replacement",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the AppImage replacement launches before removing the prior version", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-appimage-success-test-"));
  const cache = path.join(root, "cache");
  mkdirSync(cache);
  const currentFile = path.join(root, "Mirafold-1.0.0.AppImage");
  const installer = path.join(cache, "Mirafold-1.1.0.AppImage");
  const destination = path.join(root, "Mirafold-1.1.0.AppImage");
  writeFileSync(currentFile, "working-version");
  writeFileSync(installer, "replacement-version");
  const { adapter, state } = appAdapter();
  const filenameEvents = [];
  let beforeQuit = 0;
  const SafeAppImageUpdater = createSafeAppImageUpdater(AppImageUpdater, {
    emitBeforeQuit: () => (beforeQuit += 1),
  });
  const updater = downloaded(new SafeAppImageUpdater(null, adapter), installer);
  let cacheClears = 0;
  updater.downloadedUpdateHelper.clear = async () => (cacheClears += 1);
  updater.on("appimage-filename-updated", (file) => filenameEvents.push(file));
  updater.spawnLog = async (command, args, env) => {
    assert.equal(command, destination);
    assert.deepEqual(args, []);
    assert.equal(env.APPIMAGE_SILENT_INSTALL, "true");
    assert.equal(readFileSync(destination, "utf8"), "replacement-version");
    assert.equal(existsSync(currentFile), true, "the current AppImage disappeared before launch");
    return true;
  };

  try {
    assert.equal(await withAppImage(currentFile, () => updater.quitAndInstall(false, true)), true);
    assert.equal(existsSync(currentFile), false);
    assert.equal(readFileSync(destination, "utf8"), "replacement-version");
    assert.notEqual(statSync(destination).mode & 0o111, 0);
    assert.deepEqual(filenameEvents, [destination]);
    assert.equal(cacheClears, 1, "the copied installer remained in electron-updater's cache");
    assert.equal(beforeQuit, 1);
    assert.equal(state.quitCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an AppImage launch error rolls a custom filename back to its prior bytes", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-appimage-rollback-test-"));
  const cache = path.join(root, "cache");
  mkdirSync(cache);
  const currentFile = path.join(root, "Mirafold.AppImage");
  const installer = path.join(cache, "Mirafold-1.1.0.AppImage");
  writeFileSync(currentFile, "working-version");
  writeFileSync(installer, "replacement-version");
  const { adapter, state } = appAdapter();
  const SafeAppImageUpdater = createSafeAppImageUpdater(AppImageUpdater);
  const updater = downloaded(new SafeAppImageUpdater(null, adapter), installer);
  const errors = [];
  updater.on("error", (error) => errors.push(error));
  updater.spawnLog = async () => {
    assert.equal(readFileSync(currentFile, "utf8"), "replacement-version");
    const error = new Error("launch refused");
    error.code = "EIO";
    throw error;
  };

  try {
    assert.equal(await withAppImage(currentFile, () => updater.quitAndInstall(false, true)), false);
    assert.equal(readFileSync(currentFile, "utf8"), "working-version");
    assert.equal(state.quitCalls, 0);
    assert.equal(errors.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installed NSIS updater does not quit after an asynchronous launch error", async () => {
  const { adapter, state } = appAdapter();
  let beforeQuit = 0;
  const SafeNsisUpdater = createSafeNsisUpdater(NsisUpdater, {
    emitBeforeQuit: () => (beforeQuit += 1),
  });
  const updater = downloaded(
    new SafeNsisUpdater(null, adapter),
    "C:\\update-cache\\Mirafold Setup 1.1.0.exe",
  );
  const errors = [];
  updater.on("error", (error) => errors.push(error));
  updater.spawnLog = () =>
    new Promise((_, reject) => {
      setImmediate(() => {
        const error = new Error("spawn failed after returning");
        error.code = "EIO";
        reject(error);
      });
    });

  assert.equal(await updater.quitAndInstall(false, true), false);
  assert.equal(errors.length, 1);
  assert.equal(state.quitCalls, 0);
  assert.equal(beforeQuit, 0);
  assert.equal(updater.quitAndInstallCalled, false, "a recovered install can be retried");
});

test("the NSIS updater quits only after installer launch acknowledgment", async () => {
  const { adapter, state } = appAdapter();
  const lifecycle = [];
  const SafeNsisUpdater = createSafeNsisUpdater(NsisUpdater, {
    emitBeforeQuit: () => lifecycle.push("before-quit"),
  });
  const installer = "C:\\update-cache\\Mirafold Setup 1.1.0.exe";
  const updater = downloaded(new SafeNsisUpdater(null, adapter), installer);
  adapter.quit = () => {
    state.quitCalls += 1;
    lifecycle.push("quit");
  };
  updater.spawnLog = async (command, args) => {
    lifecycle.push("launched");
    assert.equal(command, installer);
    assert.deepEqual(args, ["--updated", "--force-run"]);
    return true;
  };

  assert.equal(await updater.quitAndInstall(false, true), true);
  assert.deepEqual(lifecycle, ["launched", "before-quit", "quit"]);
  assert.equal(state.quitCalls, 1);
});
