import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOAD_PAGE_URL,
  createDesktopUpdater,
  desktopUpdateStrategy,
  sanitizeUpdateDiagnostic,
  shouldUseDesktopUpdater,
} from "../src/updater.js";

const DESKTOP_VERSION = "1.2.3";
const SHELL_VERSION = "4.5.6";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeUpdater extends EventEmitter {
  checkCalls = 0;
  installCalls = [];
  checkImplementation = async () => null;
  installImplementation = () => {};

  async checkForUpdates() {
    this.checkCalls += 1;
    return this.checkImplementation();
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
    return this.installImplementation(...args);
  }
}

function harness(overrides = {}) {
  const fakeUpdater = overrides.fakeUpdater ?? new FakeUpdater();
  const messages = [];
  const logs = [];
  const lifecycle = [];
  const openedPages = [];
  let loadCalls = 0;

  const controller = createDesktopUpdater({
    isPackaged: true,
    isWindowsStore: false,
    desktopVersion: DESKTOP_VERSION,
    shellVersion: SHELL_VERSION,
    loadUpdater: async () => {
      loadCalls += 1;
      return fakeUpdater;
    },
    showMessage: async (message) => {
      messages.push(message);
      return { response: overrides.messageResponse?.(message) ?? 0 };
    },
    openDownloadPage: async (url) => {
      openedPages.push(url);
    },
    prepareInstall: async () => {
      lifecycle.push("prepare");
      return overrides.prepareInstall ? overrides.prepareInstall() : true;
    },
    recoverInstall: async () => {
      lifecycle.push("recover");
      await overrides.recoverInstall?.();
    },
    logger: {
      debug: (...values) => logs.push(["debug", ...values]),
      info: (...values) => logs.push(["info", ...values]),
      warn: (...values) => logs.push(["warn", ...values]),
      error: (...values) => logs.push(["error", ...values]),
    },
    ...overrides.controller,
  });

  return {
    controller,
    fakeUpdater,
    messages,
    logs,
    lifecycle,
    openedPages,
    get loadCalls() {
      return loadCalls;
    },
  };
}

test("the packaged Linux form selects its observed update mechanism", () => {
  const base = { isPackaged: true, isWindowsStore: false };
  assert.equal(desktopUpdateStrategy({ ...base, platform: "win32" }), "install");
  assert.equal(desktopUpdateStrategy({ ...base, platform: "linux", isAppImage: true }), "install");
  assert.equal(desktopUpdateStrategy({ ...base, platform: "linux", linuxPackageType: "deb" }), "install");
  assert.equal(desktopUpdateStrategy({ ...base, platform: "linux" }), "manual-download");
  assert.equal(
    desktopUpdateStrategy({ ...base, platform: "linux", linuxPackageType: "unknown" }),
    "manual-download",
    "an unknown package form must not be replaced as though it were installed",
  );
  assert.equal(desktopUpdateStrategy({ ...base, isPackaged: false, platform: "linux" }), "disabled");
  assert.equal(desktopUpdateStrategy({ ...base, isWindowsStore: true, platform: "win32" }), "store");
});

test("only packaged non-Store builds may construct the direct updater", async () => {
  assert.equal(shouldUseDesktopUpdater({ isPackaged: true, isWindowsStore: false }), true);
  assert.equal(shouldUseDesktopUpdater({ isPackaged: false, isWindowsStore: false }), false);
  assert.equal(shouldUseDesktopUpdater({ isPackaged: true, isWindowsStore: true }), false);

  for (const state of [
    { isPackaged: false, isWindowsStore: false, strategy: "disabled", label: "Updates available in the installed app" },
    { isPackaged: true, isWindowsStore: true, strategy: "store", label: "Updates managed by Microsoft Store" },
  ]) {
    let loadCalls = 0;
    const controller = createDesktopUpdater({
      ...state,
      desktopVersion: DESKTOP_VERSION,
      shellVersion: SHELL_VERSION,
      loadUpdater: async () => {
        loadCalls += 1;
        return new FakeUpdater();
      },
      showMessage: async () => ({ response: 0 }),
      prepareInstall: async () => true,
      recoverInstall: async () => {},
      logger: {},
    });

    assert.equal(controller.enabled, false);
    assert.equal(controller.updateStrategy, state.strategy);
    assert.equal(await controller.start(), null);
    assert.equal(await controller.checkManually(), null);
    assert.equal(loadCalls, 0, "ineligible builds must not construct electron-updater");
    assert.deepEqual(controller.helpMenuItems()[0], { label: state.label, enabled: false });
  }
});

test("startup configures one hardened background updater and never auto-installs on quit", async () => {
  const h = harness();
  h.fakeUpdater.checkImplementation = async () => {
    h.fakeUpdater.emit("update-not-available", { version: DESKTOP_VERSION });
    return {
      isUpdateAvailable: false,
      updateInfo: { version: DESKTOP_VERSION },
    };
  };

  await h.controller.start();
  await h.controller.start();

  assert.equal(h.loadCalls, 1);
  assert.equal(h.fakeUpdater.checkCalls, 1, "startup checks only once");
  assert.equal(h.fakeUpdater.autoDownload, true);
  assert.equal(h.fakeUpdater.autoInstallOnAppQuit, false);
  assert.equal(h.fakeUpdater.autoRunAppAfterInstall, true);
  assert.equal(h.fakeUpdater.allowDowngrade, false);
  assert.equal(h.fakeUpdater.disableWebInstaller, true);
  assert.ok(h.fakeUpdater.logger, "a credential-safe logger is installed");
  assert.deepEqual(h.messages, [], "a background no-update result does not interrupt startup");
});

test("a tar installation announces an update but never downloads or installs it", async () => {
  const checker = new FakeUpdater();
  checker.quitAndInstall = undefined;
  let notices = 0;
  const h = harness({
    fakeUpdater: checker,
    messageResponse: (message) => {
      if (message.title !== "Mirafold update available") return 0;
      notices += 1;
      return notices === 1 ? 1 : 0;
    },
    controller: { updateStrategy: "manual-download" },
  });
  checker.checkImplementation = async () => {
    const info = { version: "1.2.4" };
    checker.emit("update-available", info);
    return { isUpdateAvailable: true, updateInfo: info, downloadPromise: null };
  };

  await h.controller.start();
  assert.equal(h.controller.updateStrategy, "manual-download");
  assert.equal(checker.autoDownload, false);
  assert.equal(checker.autoInstallOnAppQuit, false);
  assert.equal(checker.autoRunAppAfterInstall, false);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].title, "Mirafold update available");
  assert.match(h.messages[0].detail, /extracted from the Linux \.tar\.gz archive/);
  assert.deepEqual(h.openedPages, [], "Later leaves the current extracted tree untouched");
  assert.deepEqual(h.lifecycle, []);

  await h.controller.checkManually();
  assert.equal(checker.checkCalls, 1, "a known tar update does not need another feed query");
  assert.deepEqual(h.openedPages, [DOWNLOAD_PAGE_URL]);
  assert.deepEqual(checker.installCalls, []);
  assert.deepEqual(h.lifecycle, [], "opening the download page never stops the daemon");
});

test("the Help menu exposes manual checking and separate Desktop/Shell versions", async () => {
  const h = harness();
  h.fakeUpdater.checkImplementation = async () => {
    h.fakeUpdater.emit("update-not-available", { version: DESKTOP_VERSION });
    return {
      isUpdateAvailable: false,
      updateInfo: { version: DESKTOP_VERSION },
    };
  };

  const menu = h.controller.helpMenuItems();
  assert.equal(menu[0].label, "Check for Updates…");
  assert.equal(typeof menu[0].click, "function");
  assert.deepEqual(menu.slice(2), [
    { label: `Mirafold Desktop ${DESKTOP_VERSION}`, enabled: false },
    { label: `Mirafold Shell ${SHELL_VERSION}`, enabled: false },
  ]);

  menu[0].click();
  await flushEvents();
  assert.equal(h.fakeUpdater.checkCalls, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].title, "Mirafold is up to date");
  assert.match(h.messages[0].detail, /Mirafold Desktop 1\.2\.3/);
  assert.match(h.messages[0].detail, /Mirafold Shell 4\.5\.6/);
});

test("an available update downloads in the background and Later does not install", async () => {
  const download = deferred();
  const h = harness({
    messageResponse: (message) => (message.title === "Mirafold update ready" ? 1 : 0),
  });
  h.fakeUpdater.checkImplementation = async () => {
    const info = { version: "1.2.4" };
    h.fakeUpdater.emit("update-available", info);
    return { isUpdateAvailable: true, updateInfo: info, downloadPromise: download.promise };
  };

  await h.controller.checkManually();
  assert.equal(h.messages[0].message, "Mirafold Desktop 1.2.4 is downloading.");

  h.fakeUpdater.emit("update-downloaded", { version: "1.2.4" });
  download.resolve([]);
  await flushEvents();
  await flushEvents();

  assert.equal(h.messages[1].title, "Mirafold update ready");
  assert.deepEqual(h.lifecycle, []);
  assert.deepEqual(h.fakeUpdater.installCalls, []);

  await h.controller.checkManually();
  assert.equal(h.fakeUpdater.checkCalls, 1, "a cached download does not re-query the feed");
  assert.equal(h.messages.at(-1).title, "Mirafold update ready");
  assert.deepEqual(h.fakeUpdater.installCalls, []);
});

test("installation waits for proven process-tree shutdown before invoking the platform installer", async () => {
  const stopped = deferred();
  const h = harness({
    prepareInstall: () => stopped.promise,
    messageResponse: () => 0,
  });
  h.fakeUpdater.installImplementation = () => h.lifecycle.push("install");

  await h.controller.start();
  h.fakeUpdater.emit("update-downloaded", { version: "1.2.4" });
  await flushEvents();

  assert.deepEqual(h.lifecycle, ["prepare"]);
  assert.deepEqual(h.fakeUpdater.installCalls, [], "installer must wait for clean teardown proof");

  stopped.resolve(true);
  await flushEvents();
  await flushEvents();

  assert.deepEqual(h.lifecycle, ["prepare", "install"]);
  assert.deepEqual(h.fakeUpdater.installCalls, [[false, true]]);
});

test("an unproven process-tree shutdown refuses installation and preserves the download", async () => {
  const h = harness({ prepareInstall: () => false, messageResponse: () => 0 });
  await h.controller.start();
  h.fakeUpdater.emit("update-downloaded", { version: "1.2.4" });
  await flushEvents();
  await flushEvents();

  assert.deepEqual(h.lifecycle, ["prepare"]);
  assert.deepEqual(h.fakeUpdater.installCalls, []);
  assert.equal(h.messages.at(-1).title, "Update not started");
  assert.match(h.messages.at(-1).detail, /kept the downloaded update/);
});

test("an installer error recovers Mirafold and remains non-fatal", async () => {
  const h = harness({ messageResponse: () => 0 });
  h.fakeUpdater.installImplementation = () => {
    h.fakeUpdater.emit("error", new Error("installer would not start"));
  };

  await h.controller.start();
  h.fakeUpdater.emit("update-downloaded", { version: "1.2.4" });
  await flushEvents();
  await flushEvents();

  assert.deepEqual(h.lifecycle, ["prepare", "recover"]);
  assert.equal(h.messages.at(-1).title, "Mirafold update failed");
  assert.match(h.messages.at(-1).message, /keep using this version/);
});

test("an asynchronous installer error completes recovery before the install request returns", async () => {
  const h = harness({ messageResponse: () => 0 });
  h.fakeUpdater.installImplementation = async () => {
    await flushEvents();
    h.fakeUpdater.emit("error", new Error("installer launch failed asynchronously"));
    return false;
  };

  await h.controller.start();
  h.fakeUpdater.emit("update-downloaded", { version: "1.2.4" });
  await flushEvents();
  await flushEvents();
  await flushEvents();

  assert.deepEqual(h.lifecycle, ["prepare", "recover"]);
  assert.equal(h.messages.at(-1).title, "Mirafold update failed");
  assert.match(h.messages.at(-1).detail, /asynchronously/);
});

test("manual check/download failures are reported without leaking URL credentials", async () => {
  const h = harness();
  h.fakeUpdater.checkImplementation = async () => {
    throw new Error("GET https://updates.invalid/latest.yml?token=dummy-secret failed");
  };

  assert.equal(await h.controller.checkManually(), null);
  const output = JSON.stringify({ messages: h.messages, logs: h.logs });
  assert.doesNotMatch(output, /dummy-secret/);
  assert.match(output, /token=<redacted>/);
  assert.equal(h.messages[0].title, "Mirafold update failed");
});

test("download failures from a manual check are observed and non-fatal", async () => {
  const download = deferred();
  const h = harness();
  h.fakeUpdater.checkImplementation = async () => {
    const info = { version: "1.2.4" };
    h.fakeUpdater.emit("update-available", info);
    return { isUpdateAvailable: true, updateInfo: info, downloadPromise: download.promise };
  };

  await h.controller.checkManually();
  download.reject(new Error("network unavailable"));
  await flushEvents();
  await flushEvents();

  assert.equal(h.messages.at(-1).title, "Mirafold update failed");
  assert.match(h.messages.at(-1).message, /download the update/);
  assert.deepEqual(h.fakeUpdater.installCalls, []);
});

test("updater diagnostics redact credential queries and staging identifiers", () => {
  const diagnostic = sanitizeUpdateDiagnostic(
    "GET https://updates.invalid/x?access_token=first&mode=1 token=x user id: 123e4567-e89b-12d3-a456-426614174000",
  );
  assert.doesNotMatch(diagnostic, /first|123e4567-e89b-12d3-a456-426614174000/);
  assert.match(diagnostic, /access_token=<redacted>&mode=1/);
  assert.match(diagnostic, /user id: <redacted>/);
});
