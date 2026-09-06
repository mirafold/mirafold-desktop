import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PROBE = String.raw`
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import assert from "node:assert/strict";

const mode = process.env.MIRAFOLD_PRO_MAIN_MODE;
const MARKER = "https://mirafold.com/activate";
const ACTIVATION_URL = MARKER
  + "?version=1&callback_port=43210&callback_nonce=fixture-callback"
  + "&state=fixture-state&code_challenge=fixture-challenge";
const OLD_KEY = "mf_" + "a".repeat(20);
const NEW_KEY = "mf_" + "b".repeat(20);
const STARTUP_CLEANUP_FAILURE_MODES = [
  "invalid-url-cleanup-failure",
  "page-load-cleanup-failure",
];
const STARTUP_QUIT_WAIT_MODES = [
  "quit-during-boot-failure-dialog",
  "quit-during-boot-recovery-picker",
];
const PRO_LIFECYCLE_QUIT_WAIT_MODES = [
  "quit-during-update-recovery-failure-dialog",
  "quit-during-pro-success-dialog",
];
const REMOVAL_FAILURE_QUIT_WAIT_MODES = [
  "quit-during-removal-known-failure-dialog",
  "quit-during-removal-uncertain-failure-dialog",
];
const events = [];
const dialogs = [];
const titles = [];
const openedUrls = [];
const daemonInstances = [];
let windowOpenHandler = null;
let menuTemplate = null;
let quitCalls = 0;
let updaterStarts = 0;
let keySaveAttempts = 0;
let activationStarts = 0;
let activationResumes = 0;
let activationShutdowns = 0;
let activationControllers = 0;
let storeInspections = 0;
let storeRemoveAttempts = 0;
let activeDialogs = 0;
let maximumActiveDialogs = 0;
let activeDeferred = null;
let updaterOptions = null;

const pending = Object.freeze({ checkpoint: mode });
let envelope = mode === "resume-renewal"
  ? { version: 1, licenseKey: OLD_KEY, pending }
  : [
      "resume-before-callback",
      "resume-after-exchange",
      "quit-pending",
      "remove-pending",
      "removal-vs-completion",
      "removal-during-success-dialog",
      "folder-then-callback",
      "crash-then-callback",
      "update-pending",
      "quit-during-pro-success-dialog",
    ].includes(mode)
    ? { version: 1, pending }
    : [
        "durable-key",
        "remove-key",
        "remove-cancel",
        "remove-uncertain",
        "remove-failure",
        "remove-inspect-failure",
        "quit-during-removal",
        "quit-after-removal",
        "remove-stop-crash",
        "quit-during-update-recovery-failure-dialog",
        ...REMOVAL_FAILURE_QUIT_WAIT_MODES,
      ].includes(mode)
      ? { version: 1, licenseKey: NEW_KEY }
      : null;

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function keyLabel(key) {
  if (key === OLD_KEY) return "old";
  if (key === NEW_KEY) return "new";
  return "none";
}

function deferred() {
  let resolve;
  let reject;
  const result = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { result, resolve, reject };
}

const stopEntered = mode === "quit-during-removal" ? deferred() : null;
const stopRelease = mode === "quit-during-removal" ? deferred() : null;
const restartGate = [
  "quit-after-removal",
  "quit-during-activation-boot-unproven",
  "update-during-activation-boot",
].includes(mode) ? deferred() : null;
const removalConfirmEntered = mode === "removal-during-success-dialog" ? deferred() : null;
const removalConfirmRelease = mode === "removal-during-success-dialog" ? deferred() : null;
const folderDialogEntered = [
  "unclean-crash-during-folder",
  "quit-during-folder-dialog",
  "quit-during-boot-recovery-picker",
].includes(mode) ? deferred() : null;
const folderDialogRelease = [
  "unclean-crash-during-folder",
  "quit-during-folder-dialog",
  "quit-during-boot-recovery-picker",
].includes(mode) ? deferred() : null;
const keySaveEntered = mode === "unclean-crash-during-activation" ? deferred() : null;
const keySaveRelease = mode === "unclean-crash-during-activation" ? deferred() : null;
const crashDialogEntered = mode === "quit-during-crash-dialog" ? deferred() : null;
const crashDialogRelease = mode === "quit-during-crash-dialog" ? deferred() : null;
const bootFailureDialogEntered = mode === "quit-during-boot-failure-dialog" ? deferred() : null;
const bootFailureDialogRelease = mode === "quit-during-boot-failure-dialog" ? deferred() : null;
const proLifecycleDialogEntered = [
  ...PRO_LIFECYCLE_QUIT_WAIT_MODES,
  ...REMOVAL_FAILURE_QUIT_WAIT_MODES,
].includes(mode) ? deferred() : null;
const proLifecycleDialogRelease = [
  ...PRO_LIFECYCLE_QUIT_WAIT_MODES,
  ...REMOVAL_FAILURE_QUIT_WAIT_MODES,
].includes(mode) ? deferred() : null;

const proStore = {
  async inspect() {
    storeInspections += 1;
    events.push("store.inspect");
    if ([
      "remove-inspect-failure",
      "quit-during-update-recovery-failure-dialog",
      "quit-during-removal-uncertain-failure-dialog",
    ].includes(mode) && storeInspections > 1) {
      throw new Error("sensitive-inspection-diagnostic");
    }
    return { present: envelope !== null };
  },
  async preflight() {
    events.push("store.preflight");
    if (mode === "preflight-failure") {
      const error = new Error("sensitive-preflight-diagnostic");
      error.code = "unavailable";
      throw error;
    }
    return "gnome_libsecret";
  },
  async load() {
    events.push(
      envelope?.licenseKey
        ? envelope.pending ? "store.load.renewal" : "store.load.key"
        : envelope?.pending ? "store.load.pending" : "store.load.empty",
    );
    return clone(envelope);
  },
  async save(next) {
    const savesKey = Object.hasOwn(next, "licenseKey") && !Object.hasOwn(next, "pending");
    events.push(savesKey ? "store.save.key" : "store.save.pending");
    if (savesKey) {
      keySaveAttempts += 1;
      if ([
        "store-retry",
        "retry-remove-failure",
        "retry-update-recovery",
      ].includes(mode) && keySaveAttempts === 1) {
        events.push("store.save.key.failed");
        throw new Error("sensitive-store-diagnostic");
      }
      if (mode === "store-uncertain" && keySaveAttempts === 1) {
        envelope = clone(next);
        events.push("store.save.key.uncertain");
        throw new Error("sensitive-durability-diagnostic");
      }
      if (keySaveEntered) {
        keySaveEntered.resolve();
        await keySaveRelease.result;
      }
    }
    envelope = clone(next);
  },
  async remove() {
    storeRemoveAttempts += 1;
    events.push("store.remove");
    if ([
      "remove-failure",
      "retry-remove-failure",
      "quit-during-removal-known-failure-dialog",
    ].includes(mode)) {
      events.push("store.remove.failed");
      throw new Error("sensitive-removal-diagnostic");
    }
    envelope = null;
    if (mode === "remove-uncertain") {
      events.push("store.remove.uncertain");
      throw new Error("sensitive-removal-durability-diagnostic");
    }
    return true;
  },
};

function createHandle() {
  activeDeferred = deferred();
  return Object.freeze({ activationUrl: ACTIVATION_URL, result: activeDeferred.result });
}

function createProActivationController({ store, openBrowser }) {
  assert.equal(store, proStore);
  activationControllers += 1;
  events.push("activation.controller." + activationControllers);
  return Object.freeze({
    async start() {
      activationStarts += 1;
      events.push("activation.start");
      const prior = await store.load();
      const next = { version: 1 };
      if (prior?.licenseKey) next.licenseKey = prior.licenseKey;
      next.pending = pending;
      events.push("activation.listener.bound");
      await store.save(next);
      const readback = await store.load();
      assert.deepEqual(readback, next, "pending state must survive readback before browser launch");
      const handle = createHandle();
      await openBrowser(handle.activationUrl);
      return handle;
    },
    async resume() {
      activationResumes += 1;
      events.push("activation.resume");
      const current = await store.load();
      if (!current?.pending) return null;
      return createHandle();
    },
    async shutdown() {
      activationShutdowns += 1;
      events.push("activation.shutdown");
      if (activeDeferred) {
        if (mode === "removal-vs-completion") {
          events.push("activation.result.raced");
          activeDeferred.resolve(NEW_KEY);
        } else {
          const error = new Error("sensitive-shutdown-diagnostic");
          error.code = "shutdown";
          activeDeferred.reject(error);
        }
        activeDeferred = null;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  });
}

class FakeDaemon {
  constructor(onCrash) {
    this.onCrash = onCrash;
    this.running = false;
    this.index = daemonInstances.length;
    this.stopCalls = 0;
    daemonInstances.push(this);
  }

  async start(folder, options) {
    this.folder = folder;
    this.options = options;
    this.running = true;
    events.push("daemon.start." + keyLabel(options?.licenseKey));
    if (STARTUP_QUIT_WAIT_MODES.includes(mode) && this.index === 0) {
      throw new Error("fixture daemon start failure");
    }
    if (restartGate && this.index === 1) {
      events.push("daemon.start.gated");
      await restartGate.result;
    }
    if (mode === "invalid-url-cleanup-failure" && this.index === 0) {
      return "https://invalid.example/?token=fixture";
    }
    return "http://127.0.0.1:" + (4100 + this.index) + "/?token=fixture";
  }

  async stop() {
    this.stopCalls += 1;
    events.push("daemon.stop." + this.index);
    if ([
      "quit-during-activation-boot-unproven",
      "update-during-activation-boot",
    ].includes(mode) && this.index === 1) {
      events.push("daemon.stop.unproven");
      return false;
    }
    if (STARTUP_CLEANUP_FAILURE_MODES.includes(mode) && this.index === 0) {
      events.push("daemon.stop.unproven");
      return false;
    }
    if (stopEntered && this.index === 0) {
      events.push("daemon.stop.gated");
      stopEntered.resolve();
      await stopRelease.result;
    }
    this.running = false;
    if (mode === "remove-stop-crash" && this.index === 0) {
      events.push("daemon.crash.during-stop");
      void this.onCrash({ code: 1, signal: null, stderr: "fixture stop crash", clean: true });
    }
    return true;
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.currentUrl = "";
    this.webContents = new EventEmitter();
    this.webContents.session = {};
    this.webContents.getURL = () => this.currentUrl;
    this.webContents.isDestroyed = () => false;
    this.webContents.setZoomFactor = () => {};
    this.webContents.setWindowOpenHandler = (handler) => { windowOpenHandler = handler; };
    globalThis.fixtureWindow = this;
  }

  async loadFile() {
    this.currentUrl = "file:///fixture-loading.html";
    this.webContents.emit("did-finish-load");
  }

  async loadURL(url) {
    if (mode === "page-load-cleanup-failure") {
      throw new Error("fixture page load failure");
    }
    this.currentUrl = url;
    this.webContents.emit("did-finish-load");
  }

  setTitle(value) {
    this.title = value;
    titles.push(value);
  }

  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() {}
  focus() {}
}

const app = new EventEmitter();
app.isPackaged = false;
app.requestSingleInstanceLock = () => true;
app.whenReady = () => Promise.resolve();
app.getPath = (name) => name === "userData" ? "/fixture-user-data" : "/fixture-home";
app.getVersion = () => "0.3.16";
app.quit = () => { quitCalls += 1; };

const autoUpdater = new EventEmitter();
const safeStorage = {};
const dialog = {
  async showOpenDialog() {
    if ([
      "folder-then-callback",
      "unclean-crash-during-folder",
      "quit-during-folder-dialog",
      "quit-during-boot-recovery-picker",
    ].includes(mode)) {
      events.push("dialog.folder");
      if (folderDialogEntered) {
        folderDialogEntered.resolve();
        await folderDialogRelease.result;
      }
      return { canceled: false, filePaths: ["/fixture-next-project"] };
    }
    throw new Error("the remembered fixture folder should avoid a folder dialog");
  },
  async showMessageBox(...args) {
    const options = args.at(-1);
    activeDialogs += 1;
    maximumActiveDialogs = Math.max(maximumActiveDialogs, activeDialogs);
    dialogs.push(structuredClone(options));
    events.push("dialog." + options.title);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      if (removalConfirmEntered && options.title === "Remove Mirafold Pro access?") {
        removalConfirmEntered.resolve();
        await removalConfirmRelease.result;
      }
      if (crashDialogEntered && options.title === "Mirafold stopped") {
        crashDialogEntered.resolve();
        await crashDialogRelease.result;
      }
      if (bootFailureDialogEntered && options.title === "Mirafold couldn't start") {
        bootFailureDialogEntered.resolve();
        await bootFailureDialogRelease.result;
      }
      const blocksLifecycle = (
        mode === "quit-during-update-recovery-failure-dialog"
          && options.title === "Mirafold Pro couldn't connect"
      ) || (
        mode === "quit-during-pro-success-dialog"
          && options.title === "Mirafold Pro connected"
      ) || (
        REMOVAL_FAILURE_QUIT_WAIT_MODES.includes(mode)
          && options.title === "Mirafold Pro access was not removed"
      );
      if (proLifecycleDialogEntered && blocksLifecycle) {
        proLifecycleDialogEntered.resolve();
        await proLifecycleDialogRelease.result;
      }
      if (mode === "quit-during-boot-recovery-picker" && options.title === "Mirafold couldn't start") {
        return { response: 1 };
      }
      if ([
        "store-retry",
        "retry-remove-failure",
        "retry-update-recovery",
      ].includes(mode) && options.buttons?.includes("Later")) {
        return { response: 1 };
      }
      if (mode === "remove-cancel" && options.title === "Remove Mirafold Pro access?") {
        return { response: 1 };
      }
      return { response: 0 };
    } finally {
      activeDialogs -= 1;
    }
  },
};
const Menu = {
  buildFromTemplate(template) {
    menuTemplate = template;
    return template;
  },
  setApplicationMenu() {},
};
const shell = {
  async openExternal(url) {
    openedUrls.push(url);
    events.push(url === ACTIVATION_URL ? "browser.activation" : "browser.external");
    if (
      mode === "browser-retry"
      && url === ACTIVATION_URL
      && openedUrls.filter((item) => item === ACTIVATION_URL).length === 1
    ) {
      const error = new Error("sensitive-browser-diagnostic");
      error.code = "browser";
      throw error;
    }
  },
  async openPath() { return ""; },
};

mock.module("electron", {
  namedExports: { app, autoUpdater, BrowserWindow: FakeWindow, dialog, Menu, safeStorage, shell },
});
mock.module(new URL("./src/daemon.js", import.meta.url).href, {
  namedExports: { Daemon: FakeDaemon },
});
mock.module(new URL("./src/interface-scale.js", import.meta.url).href, {
  namedExports: {
    DEFAULT_INTERFACE_SCALE: 1,
    interfaceScaleShortcut: () => null,
    createInterfaceScaleController: () => ({
      scale: 1,
      apply() {},
      zoomIn() {},
      zoomOut() {},
      reset() {},
    }),
  },
});
mock.module(new URL("./src/permissions.js", import.meta.url).href, {
  namedExports: {
    installPermissionGuards(_session, { trustedWebContents, getDaemonOrigin }) {
      assert.ok(trustedWebContents);
      assert.equal(typeof getDaemonOrigin, "function");
      events.push("permissions.installed");
    },
  },
});
mock.module(new URL("./src/pro-store.js", import.meta.url).href, {
  namedExports: {
    PRO_STORE_VERSION: 1,
    createProStore: () => proStore,
  },
});
mock.module(new URL("./src/pro-activation.js", import.meta.url).href, {
  namedExports: { createProActivationController },
});
mock.module(new URL("./src/state.js", import.meta.url).href, {
  namedExports: {
    interfaceScale: () => 1,
    lastFolder: () => "/fixture-project",
    setInterfaceScale() {},
    setLastFolder() {},
  },
});
mock.module(new URL("./src/updater.js", import.meta.url).href, {
  namedExports: {
    APT_MANAGED_MARKER: "/fixture-apt-marker",
    desktopUpdateStrategy: () => "disabled",
    createDesktopUpdater: (options) => {
      updaterOptions = options;
      return {
        helpMenuItems: () => [],
        async start() {
          updaterStarts += 1;
          events.push("updater.start");
        },
      };
    },
  },
});

await import(new URL("./src/main.js?pro-main-probe=" + mode, import.meta.url));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

function eventIndex(name, after = -1) {
  const index = events.indexOf(name, after + 1);
  assert.notEqual(index, -1, "missing event: " + name + " after " + after + " in " + JSON.stringify(events));
  return index;
}

function assertOrdered(names) {
  let prior = -1;
  for (const name of names) prior = eventIndex(name, prior);
}

function resolveActivation() {
  assert.ok(activeDeferred, "no activation result is waiting");
  events.push("activation.result");
  const current = activeDeferred;
  activeDeferred = null;
  current.resolve(NEW_KEY);
}

async function quitBeforeProLifecycleDialogSettles(message) {
  await proLifecycleDialogEntered.result;
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  await waitFor(() => quitCalls === 1, message);
  assert.equal(preventions, 1);
  proLifecycleDialogRelease.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

await waitFor(
  () => menuTemplate !== null
    && daemonInstances.length === 1
    && (
      STARTUP_CLEANUP_FAILURE_MODES.includes(mode)
      || STARTUP_QUIT_WAIT_MODES.includes(mode)
      || updaterStarts === 1
    ),
  "the initial Desktop boot did not finish",
);
assert.equal(typeof windowOpenHandler, "function", "the native popup handler was not installed");
const projectMenu = menuTemplate.find((item) => item.label === "Project");
const openFolderItem = projectMenu.submenu.find((item) => item.label === "Open Project Folder…");
const removeProItem = projectMenu.submenu.find(
  (item) => item.label === "Remove Pro Access from This Device…",
);
assert.ok(removeProItem, "Linux must expose the neutral device-removal command");

if (STARTUP_QUIT_WAIT_MODES.includes(mode)) {
  if (mode === "quit-during-boot-failure-dialog") {
    await bootFailureDialogEntered.result;
  } else {
    await folderDialogEntered.result;
  }
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  await waitFor(() => quitCalls === 1, "quit waited for native boot recovery UI");
  assert.equal(preventions, 1);
  if (bootFailureDialogRelease) bootFailureDialogRelease.resolve();
  if (folderDialogRelease) folderDialogRelease.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(daemonInstances.length, 1, "retired boot recovery started a daemon");
  assert.equal(daemonInstances[0].running, false);
  assert.equal(updaterStarts, 0);
} else if (STARTUP_CLEANUP_FAILURE_MODES.includes(mode)) {
  await waitFor(() => quitCalls === 1, "startup cleanup failure was not terminal");
  assert.equal(daemonInstances.length, 1);
  assert.equal(daemonInstances[0].stopCalls, 1);
  assert.equal(daemonInstances[0].running, true, "fixture must model the unproved live tree");
  assert.equal(updaterStarts, 0);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, "Mirafold couldn't stop safely");
} else if (mode === "quit-during-update-recovery-failure-dialog") {
  assert.equal(await updaterOptions.prepareInstall(), true);
  const recovering = updaterOptions.recoverInstall();
  await quitBeforeProLifecycleDialogSettles("quit waited for update-recovery error UI");
  await recovering;
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assert.equal(daemonInstances.length, 2);
  assert.equal(daemonInstances[1].running, false);
} else if (mode === "quit-during-pro-success-dialog") {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  resolveActivation();
  await quitBeforeProLifecycleDialogSettles("quit waited for Pro success UI");
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assert.equal(daemonInstances.length, 2);
  assert.equal(daemonInstances[1].running, false);
} else if (REMOVAL_FAILURE_QUIT_WAIT_MODES.includes(mode)) {
  removeProItem.click();
  await quitBeforeProLifecycleDialogSettles("quit waited for removal-failure UI");
  assert.deepEqual(
    envelope,
    mode === "quit-during-removal-known-failure-dialog"
      ? { version: 1, licenseKey: NEW_KEY }
      : null,
  );
  assert.equal(
    daemonInstances.length,
    mode === "quit-during-removal-known-failure-dialog" ? 2 : 1,
  );
  assert.equal(daemonInstances.at(-1).running, false);
} else if (mode === "happy") {
  const window = globalThis.fixtureWindow;
  const daemonUrl = window.currentUrl;

  window.currentUrl = "file:///fixture-loading.html";
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  window.currentUrl = "http://127.0.0.1:4999/?token=stale";
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  window.currentUrl = daemonUrl;
  assert.deepEqual(windowOpenHandler({ url: MARKER + "?lookalike=1" }), { action: "deny" });
  assert.deepEqual(windowOpenHandler({ url: MARKER, postBody: { data: [] } }), { action: "deny" });
  assert.deepEqual(windowOpenHandler({ url: "https://example.com/" }), { action: "deny" });
  await waitFor(() => openedUrls.length === 4, "ordinary external popup behavior did not settle");
  assert.equal(activationStarts, 0, "an untrusted or inexact marker started native activation");

  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => events.includes("browser.activation"), "the trusted marker did not open activation");
  assert.equal(activationStarts, 1, "duplicate clicks created a second activation flow");
  const openedActivation = new URL(openedUrls.at(-1));
  assert.equal(openedActivation.origin + openedActivation.pathname, MARKER);
  assert.deepEqual(
    [...openedActivation.searchParams.keys()],
    ["version", "callback_port", "callback_nonce", "state", "code_challenge"],
  );
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 2 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "successful activation did not restart and report success",
  );
  assertOrdered([
    "store.preflight",
    "activation.start",
    "activation.listener.bound",
    "store.save.pending",
    "store.load.pending",
    "browser.activation",
    "activation.result",
    "store.save.key",
    "store.load.key",
    "daemon.stop.0",
    "daemon.start.new",
    "dialog.Mirafold Pro connected",
  ]);
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assert.equal(daemonInstances[0].folder, "/fixture-project");
  assert.equal(daemonInstances[1].folder, "/fixture-project");
  assert.equal(daemonInstances[0].stopCalls, 1);
  assert.doesNotMatch(JSON.stringify({ dialogs, titles, openedUrls }), new RegExp(NEW_KEY));
  assert.ok(titles.some((title) => title.includes("Preparing Pro activation")));
  assert.ok(titles.some((title) => title.includes("Finish Pro activation")));
  assert.ok(titles.some((title) => title.includes("Saving Pro access securely")));
  assert.ok(titles.some((title) => title.includes("Restarting with Pro access")));
} else if (mode === "preflight-failure") {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => dialogs.length === 1, "the preflight failure was not reported");
  assertOrdered(["store.preflight", "dialog.Mirafold Pro couldn't connect"]);
  assert.equal(activationStarts, 0);
  assert.equal(openedUrls.length, 0);
  assert.equal(daemonInstances.length, 1);
  assert.doesNotMatch(JSON.stringify(dialogs), /sensitive-preflight-diagnostic/);
} else if (mode === "browser-retry") {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(
    () => dialogs.some((item) => item.detail?.includes("system browser")),
    "the browser-open failure was not reported",
  );
  assert.ok(envelope?.pending, "the browser-open failure discarded the saved flow");
  assert.equal(activationStarts, 1);
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(
    () => activationResumes === 1
      && openedUrls.filter((item) => item === ACTIVATION_URL).length === 2
      && activeDeferred !== null,
    "the trusted retry did not resume and reopen the exact saved flow",
  );
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 2 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "the reopened activation did not complete",
  );
  assert.equal(activationStarts, 1);
  assert.equal(activationResumes, 1);
  assert.doesNotMatch(JSON.stringify(dialogs), /sensitive-browser-diagnostic/);
} else if (mode === "store-uncertain") {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => events.includes("browser.activation"), "activation did not reach the browser");
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 2 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "a committed write with uncertain durability did not complete after exact readback",
  );
  assertOrdered([
    "activation.result",
    "store.save.key",
    "store.save.key.uncertain",
    "store.load.key",
    "daemon.stop.0",
    "daemon.start.new",
  ]);
  assert.equal(dialogs.filter((item) => item.type === "error").length, 0);
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
} else if ([
  "store-retry",
  "retry-remove-failure",
  "retry-update-recovery",
].includes(mode)) {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => events.includes("browser.activation"), "activation did not reach the browser");
  resolveActivation();
  await waitFor(
    () => dialogs.some((item) => item.buttons?.includes("Later")),
    "the failed secure save did not offer its bounded retry",
  );
  assert.equal(daemonInstances.length, 1, "an unconfirmed key restarted the daemon");
  assert.ok(envelope?.pending, "an unconfirmed key replaced the durable pending flow");
  if (mode === "retry-remove-failure") {
    const currentRemoveItem = menuTemplate.find((item) => item.label === "Project").submenu.find(
      (item) => item.label === "Remove Pro Access from This Device…",
    );
    assert.equal(currentRemoveItem.enabled, true);
    currentRemoveItem.click();
    await waitFor(
      () => daemonInstances.length === 2
        && dialogs.some((item) => item.title === "Mirafold Pro access was not removed"),
      "failed removal did not restore the session with the retry key",
    );
    assert.equal(activationResumes, 0, "failed removal resumed a consumed pending exchange");
  } else if (mode === "retry-update-recovery") {
    assert.equal(await updaterOptions.prepareInstall(), true);
    await updaterOptions.recoverInstall();
    await waitFor(
      () => daemonInstances.length === 2 && daemonInstances[1].running,
      "failed updater recovery did not restore the session with the retry key",
    );
    assert.equal(activationResumes, 0, "updater recovery resumed a consumed pending exchange");
  }

  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(
    () => daemonInstances.length === (mode === "store-retry" ? 2 : 3)
      && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "the exact marker did not retry the secure save",
  );
  assert.equal(activationStarts, 1, "the storage retry created another activation flow");
  assert.equal(openedUrls.filter((url) => url.startsWith(MARKER + "?")).length, 1);
  assert.equal(keySaveAttempts, 2);
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assertOrdered([
    "activation.result",
    "store.save.key",
    "store.save.key.failed",
    "store.load.pending",
    "dialog.Mirafold Pro couldn't connect",
    ...(mode === "retry-remove-failure" ? [
      "activation.shutdown",
      "store.remove",
      "store.remove.failed",
      "store.load.pending",
      "daemon.start.none",
      "dialog.Mirafold Pro access was not removed",
    ] : mode === "retry-update-recovery" ? [
      "activation.shutdown",
      "daemon.stop.0",
      "activation.controller.2",
      "daemon.start.none",
    ] : []),
    "store.save.key",
    "store.load.key",
    mode === "store-retry" ? "daemon.stop.0" : "daemon.stop.1",
    "daemon.start.new",
  ]);
} else if (
  mode === "resume-before-callback"
  || mode === "resume-after-exchange"
  || mode === "resume-renewal"
) {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  assert.equal(activationStarts, 0, "restart replaced the exact pending flow");
  assert.equal(openedUrls.length, 0, "automatic resume reopened a capability-bearing browser URL");
  assert.equal(
    keyLabel(daemonInstances[0].options?.licenseKey),
    mode === "resume-renewal" ? "old" : "none",
  );
  if (mode === "resume-before-callback") {
    assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
    await waitFor(
      () => openedUrls.filter((item) => item === ACTIVATION_URL).length === 1,
      "an explicit marker did not reopen the active saved flow",
    );
    assert.equal(activationResumes, 1);
    assert.equal(activationStarts, 0);
  }
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 2 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "resumed activation did not complete",
  );
  assertOrdered([
    "activation.resume",
    mode === "resume-renewal" ? "store.load.renewal" : "store.load.pending",
    "activation.result",
    "store.save.key",
    "store.load.key",
    "daemon.stop.0",
    "daemon.start.new",
  ]);
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
} else if (mode === "durable-key") {
  assert.equal(keyLabel(daemonInstances[0].options?.licenseKey), "new");
  assert.equal(activationStarts, 0);
  assert.equal(activationResumes, 0);
  assert.equal(openedUrls.length, 0);
  assert.equal(dialogs.length, 0);
} else if (mode === "remove-key" || mode === "remove-uncertain" || mode === "remove-stop-crash") {
  assert.equal(removeProItem.enabled, true);
  removeProItem.click();
  removeProItem.click();
  await waitFor(
    () => storeRemoveAttempts === 1 && daemonInstances.length === 2 && daemonInstances[1].running,
    "confirmed key removal did not restart unentitled",
  );
  assertOrdered([
    "activation.shutdown",
    "daemon.stop.0",
    ...(mode === "remove-stop-crash" ? ["daemon.crash.during-stop"] : []),
    "store.remove",
    ...(mode === "remove-uncertain" ? ["store.remove.uncertain"] : []),
    "store.inspect",
    "activation.controller.2",
    "daemon.start.none",
  ]);
  assert.equal(storeInspections, 2, "removal must inspect its final state exactly once");
  assert.equal(activationControllers, 2, "successful removal must install a fresh controller");
  assert.equal(daemonInstances[0].stopCalls, 1);
  assert.deepEqual(envelope, null);
  assert.equal(dialogs.length, 1, "duplicate removal clicks stacked a confirmation");
  assert.equal(dialogs[0].title, "Remove Mirafold Pro access?");
  assert.match(dialogs[0].detail, /does not have account recovery/);
  assert.match(dialogs[0].detail, /Mirafold support/);
  assert.equal(maximumActiveDialogs, 1);
  assert.equal(
    dialogs.some((item) => item.title === "Mirafold stopped"),
    false,
    "an explicit stop produced a competing crash dialog",
  );
  assert.equal(
    menuTemplate.find((item) => item.label === "Project").submenu.find(
      (item) => item.label === "Remove Pro Access from This Device…",
    ).enabled,
    false,
  );
  assert.doesNotMatch(JSON.stringify({ dialogs, titles }), new RegExp(NEW_KEY));
} else if (mode === "remove-cancel") {
  assert.equal(removeProItem.enabled, true);
  removeProItem.click();
  removeProItem.click();
  await waitFor(() => dialogs.length === 1, "the removal confirmation did not open");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assert.equal(storeRemoveAttempts, 0, "canceling removal touched encrypted state");
  assert.equal(activationShutdowns, 0, "canceling removal closed the activation controller");
  assert.equal(daemonInstances.length, 1, "canceling removal restarted the daemon");
  assert.equal(daemonInstances[0].stopCalls, 0, "canceling removal stopped the daemon");
  assert.equal(activationControllers, 1);
  assert.equal(maximumActiveDialogs, 1);
} else if (mode === "remove-pending" || mode === "removal-vs-completion") {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  assert.equal(removeProItem.enabled, true);
  removeProItem.click();
  removeProItem.click();
  await waitFor(
    () => storeRemoveAttempts === 1 && daemonInstances.length === 2 && daemonInstances[1].running,
    "pending-flow removal did not settle",
  );
  assertOrdered([
    "activation.shutdown",
    ...(mode === "removal-vs-completion" ? ["activation.result.raced"] : []),
    "daemon.stop.0",
    "store.remove",
    "store.inspect",
    "daemon.start.none",
  ]);
  assert.deepEqual(envelope, null);
  assert.equal(events.includes("store.save.key"), false, "a retired exchange replaced removed state");
  assert.equal(
    dialogs.filter((item) => item.title !== "Remove Mirafold Pro access?").length,
    0,
    "retirement exposed a stale activation result",
  );
  assert.equal(dialogs.length, 1);
  assert.equal(maximumActiveDialogs, 1);
} else if (mode === "removal-during-success-dialog") {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  removeProItem.click();
  await removalConfirmEntered.result;
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 2 && daemonInstances[1].running,
    "activation did not reach its success-report boundary",
  );
  removalConfirmRelease.resolve();
  await waitFor(
    () => storeRemoveAttempts === 1 && daemonInstances.length === 3 && daemonInstances[2].running,
    "confirmed removal did not follow the completed activation",
  );
  assert.deepEqual(envelope, null);
  assert.deepEqual(
    dialogs.map((item) => item.title),
    ["Remove Mirafold Pro access?"],
    "a stale activation-success dialog appeared after confirmed removal",
  );
  assertOrdered([
    "activation.result",
    "store.save.key",
    "daemon.stop.0",
    "daemon.start.new",
    "activation.shutdown",
    "daemon.stop.1",
    "store.remove",
    "store.inspect",
    "daemon.start.none",
  ]);
  assert.equal(maximumActiveDialogs, 1);
} else if (mode === "remove-failure") {
  assert.equal(removeProItem.enabled, true);
  removeProItem.click();
  await waitFor(
    () => daemonInstances.length === 2
      && dialogs.some((item) => item.title === "Mirafold Pro access was not removed"),
    "a known failed removal did not restore the prior session",
  );
  assertOrdered([
    "activation.shutdown",
    "daemon.stop.0",
    "store.remove",
    "store.remove.failed",
    "store.inspect",
    "store.load.key",
    "activation.controller.2",
    "daemon.start.new",
    "dialog.Mirafold Pro access was not removed",
  ]);
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assert.equal(daemonInstances[1].running, true);
  assert.equal(dialogs.length, 2);
  assert.equal(maximumActiveDialogs, 1);
  assert.doesNotMatch(JSON.stringify(dialogs), /sensitive-removal/);
} else if (mode === "remove-inspect-failure") {
  removeProItem.click();
  await waitFor(() => quitCalls === 1, "an unknowable removal outcome did not stop safely");
  assert.deepEqual(envelope, null, "the fixture must model an already-unlinked record");
  assert.equal(daemonInstances.length, 1, "an unknowable outcome launched a replacement daemon");
  assert.equal(daemonInstances[0].running, false);
  assert.equal(activationControllers, 1, "an unknowable outcome installed another listener owner");
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[1].title, "Mirafold Pro access was not removed");
  assert.match(dialogs[1].detail, /cannot safely guess/);
  assert.doesNotMatch(JSON.stringify(dialogs), /sensitive-inspection/);
  assertOrdered([
    "activation.shutdown",
    "daemon.stop.0",
    "store.remove",
    "store.inspect",
    "dialog.Mirafold Pro access was not removed",
  ]);
} else if (mode === "folder-then-callback") {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  openFolderItem.click();
  openFolderItem.click();
  await waitFor(
    () => daemonInstances.length === 2 && daemonInstances[1].running,
    "folder change did not settle before activation completion",
  );
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 3 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "activation did not restart the chosen folder",
  );
  assertOrdered([
    "dialog.folder",
    "daemon.stop.0",
    "daemon.start.none",
    "activation.result",
    "store.save.key",
    "daemon.stop.1",
    "daemon.start.new",
  ]);
  assert.deepEqual(daemonInstances.map((item) => item.folder), [
    "/fixture-project",
    "/fixture-next-project",
    "/fixture-next-project",
  ]);
  assert.equal(activationShutdowns, 0, "a folder change discarded a device-level activation");
  assert.equal(
    events.filter((item) => item === "dialog.folder").length,
    1,
    "duplicate folder commands opened a second native chooser",
  );
  assert.equal(maximumActiveDialogs, 1);
} else if (mode === "crash-then-callback") {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  daemonInstances[0].running = false;
  void daemonInstances[0].onCrash({
    code: 1,
    signal: null,
    stderr: "fixture crash",
    clean: true,
  });
  await waitFor(
    () => daemonInstances.length === 2 && daemonInstances[1].running,
    "crash recovery did not restart once",
  );
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 3 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "activation completion did not follow crash recovery",
  );
  assertOrdered([
    "dialog.Mirafold stopped",
    "daemon.start.none",
    "activation.result",
    "store.save.key",
    "daemon.stop.1",
    "daemon.start.new",
    "dialog.Mirafold Pro connected",
  ]);
  assert.equal(dialogs.length, 2);
  assert.equal(maximumActiveDialogs, 1, "crash and Pro dialogs overlapped");
} else if (mode === "quit-during-crash-dialog") {
  daemonInstances[0].running = false;
  void daemonInstances[0].onCrash({
    code: 1,
    signal: null,
    stderr: "fixture crash",
    clean: true,
  });
  await crashDialogEntered.result;
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  await waitFor(() => quitCalls === 1, "quit waited for the open crash dialog");
  assert.equal(preventions, 1);
  crashDialogRelease.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(daemonInstances.length, 1, "the retired crash choice restarted the daemon");
} else if (mode === "unclean-crash-during-folder") {
  openFolderItem.click();
  await folderDialogEntered.result;
  daemonInstances[0].running = false;
  void daemonInstances[0].onCrash({
    code: 1,
    signal: null,
    stderr: "fixture unclean crash",
    clean: false,
  });
  folderDialogRelease.resolve();
  await waitFor(() => quitCalls === 1, "unclean crash cleanup did not remain terminal");
  assert.equal(daemonInstances.length, 1, "an unclean crash allowed a replacement daemon");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, "Mirafold couldn't stop safely");
  assertOrdered(["dialog.folder", "dialog.Mirafold couldn't stop safely"]);
} else if (mode === "unclean-crash-during-activation") {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => events.includes("browser.activation"), "activation did not reach the browser");
  resolveActivation();
  await keySaveEntered.result;
  daemonInstances[0].running = false;
  void daemonInstances[0].onCrash({
    code: 1,
    signal: null,
    stderr: "fixture unclean crash",
    clean: false,
  });
  keySaveRelease.resolve();
  await waitFor(() => quitCalls === 1, "unclean crash cleanup did not become terminal");
  assert.equal(daemonInstances.length, 1, "activation completion started a replacement daemon");
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, "Mirafold couldn't stop safely");
  assert.equal(
    dialogs.some((item) => item.title === "Mirafold Pro connected"),
    false,
    "activation reported success after an unclean daemon crash",
  );
} else if (mode === "quit-during-folder-dialog") {
  openFolderItem.click();
  await folderDialogEntered.result;
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  await waitFor(() => quitCalls === 1, "quit waited for the open folder picker");
  assert.equal(preventions, 1);
  assert.equal(daemonInstances.length, 1);
  assert.equal(daemonInstances[0].running, false);
  folderDialogRelease.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(daemonInstances.length, 1, "the retired folder choice started a daemon");
} else if (mode === "update-pending") {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  assert.equal(await updaterOptions.prepareInstall(), true);
  assert.deepEqual(envelope, { version: 1, pending });
  assert.equal(daemonInstances[0].running, false);
  assertOrdered(["activation.shutdown", "daemon.stop.0"]);
  await updaterOptions.recoverInstall();
  await waitFor(
    () => activationControllers === 2 && activationResumes === 2 && activeDeferred !== null,
    "failed update recovery did not restore the exact pending listener",
  );
  assert.equal(daemonInstances.length, 2);
  assert.equal(keyLabel(daemonInstances[1].options?.licenseKey), "none");
  resolveActivation();
  await waitFor(
    () => daemonInstances.length === 3 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
    "recovered activation did not complete",
  );
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assertOrdered([
    "activation.shutdown",
    "daemon.stop.0",
    "activation.controller.2",
    "daemon.start.none",
    "activation.resume",
    "activation.result",
    "store.save.key",
    "daemon.stop.1",
    "daemon.start.new",
  ]);
  assert.equal(maximumActiveDialogs, 1);
} else if (mode === "update-during-activation-boot") {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => events.includes("browser.activation"), "activation did not reach the browser");
  resolveActivation();
  await waitFor(
    () => events.includes("daemon.start.gated"),
    "activation completion did not enter its replacement boot",
  );
  const preparation = updaterOptions.prepareInstall();
  restartGate.resolve();
  assert.equal(
    await preparation,
    false,
    "update installation ignored an unproved stale-boot cleanup",
  );
  assert.equal(daemonInstances.length, 2);
  assert.equal(daemonInstances[1].stopCalls, 1);
  assert.equal(quitCalls, 1);
  assert.equal(dialogs.at(-1).title, "Mirafold couldn't stop safely");
  assertOrdered([
    "daemon.start.gated",
    "daemon.stop.1",
    "daemon.stop.unproven",
    "dialog.Mirafold couldn't stop safely",
  ]);
} else if (mode === "quit-during-activation-boot-unproven") {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => events.includes("browser.activation"), "activation did not reach the browser");
  resolveActivation();
  await waitFor(
    () => events.includes("daemon.start.gated"),
    "activation completion did not enter its replacement boot",
  );
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  restartGate.resolve();
  await waitFor(() => quitCalls === 1, "quit cleanup did not finish");
  assert.equal(preventions, 1);
  assert.equal(
    daemonInstances[1].stopCalls,
    2,
    "quit lost the failed stale-boot cleanup result with its daemon reference",
  );
  assert.equal(daemonInstances[1].running, true, "fixture must model the unproved live tree");
} else if (mode === "quit-during-removal") {
  removeProItem.click();
  await stopEntered.result;
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  stopRelease.resolve();
  await waitFor(() => quitCalls === 1, "quit did not retire in-progress removal");
  assert.equal(preventions, 1);
  assert.deepEqual(envelope, { version: 1, licenseKey: NEW_KEY });
  assert.equal(storeRemoveAttempts, 0, "quit allowed removal to begin after its stop gate");
  assert.equal(daemonInstances[0].running, false);
  assert.equal(daemonInstances.length, 1);
  assertOrdered(["activation.shutdown", "daemon.stop.0"]);
  assert.equal(dialogs.length, 1);
} else if (mode === "quit-after-removal") {
  removeProItem.click();
  await waitFor(
    () => events.includes("store.inspect") && events.includes("daemon.start.gated"),
    "removal did not reach its unentitled restart gate",
  );
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  restartGate.resolve();
  await waitFor(() => quitCalls === 1, "quit did not retire the post-removal restart");
  assert.equal(preventions, 1);
  assert.deepEqual(envelope, null, "quit resurrected state already removed");
  assert.equal(daemonInstances.length, 2);
  assert.equal(daemonInstances[0].running, false);
  assert.equal(daemonInstances[1].running, false);
  assert.equal(daemonInstances[1].stopCalls, 1, "the superseded restart was orphaned");
  assert.equal(dialogs.length, 1);
  assertOrdered([
    "activation.shutdown",
    "daemon.stop.0",
    "store.remove",
    "store.inspect",
    "daemon.start.none",
    "daemon.start.gated",
    "daemon.stop.1",
  ]);
} else if (mode === "quit-pending") {
  await waitFor(() => activationResumes === 1 && activeDeferred !== null, "pending activation did not resume");
  let preventions = 0;
  app.emit("before-quit", { preventDefault: () => { preventions += 1; } });
  await waitFor(() => quitCalls === 1, "quit cleanup did not finish");
  assert.equal(preventions, 1);
  assert.equal(activationShutdowns, 1);
  assert.deepEqual(envelope, { version: 1, pending });
  assert.equal(dialogs.length, 0, "shutdown exposed the activation error to the user");
  assertOrdered(["activation.shutdown", "daemon.stop.0"]);
} else {
  throw new Error("unknown probe mode: " + mode);
}

process.stdout.write("Pro main lifecycle probe passed\n");
`;

function runProbe(mode) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "--eval", PROBE],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MIRAFOLD_PRO_MAIN_MODE: mode },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  assert.match(result.stdout, /Pro main lifecycle probe passed/);
}

const linuxOnly = { skip: process.platform !== "linux" };

test("the trusted Desktop marker drives preflight, durable activation, restart, and native UI in order", linuxOnly, () => {
  runProbe("happy");
});

test("a secure-storage preflight failure opens no browser and exposes no supplied diagnostic", linuxOnly, () => {
  runProbe("preflight-failure");
});

test("invalid startup output and page-load failure report an unproved daemon cleanup", linuxOnly, () => {
  runProbe("invalid-url-cleanup-failure");
  runProbe("page-load-cleanup-failure");
});

test("quit bypasses the native boot-failure dialog and recovery folder picker", linuxOnly, () => {
  runProbe("quit-during-boot-failure-dialog");
  runProbe("quit-during-boot-recovery-picker");
});

test("quit bypasses Pro success and update-recovery failure dialogs", linuxOnly, () => {
  runProbe("quit-during-update-recovery-failure-dialog");
  runProbe("quit-during-pro-success-dialog");
});

test("quit bypasses known and uncertain removal-failure dialogs", linuxOnly, () => {
  runProbe("quit-during-removal-known-failure-dialog");
  runProbe("quit-during-removal-uncertain-failure-dialog");
});

test("a browser-open failure resumes and reopens the same saved flow only after another trusted marker", linuxOnly, () => {
  runProbe("browser-retry");
});

test("a post-purchase storage failure retries the same key only through the trusted marker", linuxOnly, () => {
  runProbe("store-retry");
});

test("failed removal retains the unsaved purchased key", linuxOnly, () => {
  runProbe("retry-remove-failure");
});

test("failed updater recovery retains the unsaved purchased key", linuxOnly, () => {
  runProbe("retry-update-recovery");
});

test("an uncertain secure write proceeds only when exact readback proves the replacement key", linuxOnly, () => {
  runProbe("store-uncertain");
});

test("restart resumes pending state at each pre-store crash checkpoint and preserves renewal access", linuxOnly, () => {
  runProbe("resume-before-callback");
  runProbe("resume-after-exchange");
  runProbe("resume-renewal");
});

test("a durable replacement key reaches the first daemon without reopening activation", linuxOnly, () => {
  runProbe("durable-key");
});

test("confirmed removal closes Pro, stops once, deletes exact state, and restarts unentitled", linuxOnly, () => {
  runProbe("remove-key");
  runProbe("remove-pending");
  runProbe("remove-uncertain");
  runProbe("remove-stop-crash");
});

test("canceling or duplicating the removal confirmation changes no state", linuxOnly, () => {
  runProbe("remove-cancel");
});

test("removal owns a simultaneous exchange result and a known failure restores prior access", linuxOnly, () => {
  runProbe("removal-vs-completion");
  runProbe("removal-during-success-dialog");
  runProbe("remove-failure");
  runProbe("remove-inspect-failure");
});

test("folder, crash, and updater transitions serialize with a pending activation", linuxOnly, () => {
  runProbe("folder-then-callback");
  runProbe("crash-then-callback");
  runProbe("update-pending");
});

test("update ownership observes a replacement boot's failed cleanup proof", linuxOnly, () => {
  runProbe("update-during-activation-boot");
});

test("quit observes a replacement boot's failed stale-cleanup proof", linuxOnly, () => {
  runProbe("quit-during-activation-boot-unproven");
});

test("an unclean crash prevents a late folder choice from starting a replacement", linuxOnly, () => {
  runProbe("unclean-crash-during-folder");
});

test("an unclean crash remains terminal while activation completion owns the lifecycle", linuxOnly, () => {
  runProbe("unclean-crash-during-activation");
});

test("quit does not wait for an open native crash dialog", linuxOnly, () => {
  runProbe("quit-during-crash-dialog");
});

test("quit does not wait for an open native folder picker", linuxOnly, () => {
  runProbe("quit-during-folder-dialog");
});

test("quit gives removal one final state on either side of the encrypted delete", linuxOnly, () => {
  runProbe("quit-during-removal");
  runProbe("quit-after-removal");
});

test("quit closes a resumed activation before stopping the daemon and preserves pending state", linuxOnly, () => {
  runProbe("quit-pending");
});
