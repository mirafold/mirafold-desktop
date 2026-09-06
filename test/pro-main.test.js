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
let activeDeferred = null;

const pending = Object.freeze({ checkpoint: mode });
let envelope = mode === "resume-renewal"
  ? { version: 1, licenseKey: OLD_KEY, pending }
  : mode === "resume-before-callback" || mode === "resume-after-exchange" || mode === "quit-pending"
    ? { version: 1, pending }
    : mode === "durable-key"
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

const proStore = {
  async inspect() {
    events.push("store.inspect");
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
      if (mode === "store-retry" && keySaveAttempts === 1) {
        events.push("store.save.key.failed");
        throw new Error("sensitive-store-diagnostic");
      }
      if (mode === "store-uncertain" && keySaveAttempts === 1) {
        envelope = clone(next);
        events.push("store.save.key.uncertain");
        throw new Error("sensitive-durability-diagnostic");
      }
    }
    envelope = clone(next);
  },
};

function createHandle() {
  activeDeferred = deferred();
  return Object.freeze({ activationUrl: ACTIVATION_URL, result: activeDeferred.result });
}

function createProActivationController({ store, openBrowser }) {
  assert.equal(store, proStore);
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
        const error = new Error("sensitive-shutdown-diagnostic");
        error.code = "shutdown";
        activeDeferred.reject(error);
        activeDeferred = null;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  });
}

class FakeDaemon {
  constructor() {
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
    return "http://127.0.0.1:" + (4100 + this.index) + "/?token=fixture";
  }

  async stop() {
    this.stopCalls += 1;
    this.running = false;
    events.push("daemon.stop." + this.index);
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
    throw new Error("the remembered fixture folder should avoid a folder dialog");
  },
  async showMessageBox(...args) {
    const options = args.at(-1);
    dialogs.push(structuredClone(options));
    events.push("dialog." + options.title);
    if (mode === "store-retry" && options.buttons?.includes("Later")) {
      return { response: 1 };
    }
    return { response: 0 };
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
    createDesktopUpdater: () => ({
      helpMenuItems: () => [],
      async start() {
        updaterStarts += 1;
        events.push("updater.start");
      },
    }),
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
  assert.notEqual(index, -1, "missing event: " + name + " after " + after);
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

await waitFor(
  () => menuTemplate !== null && daemonInstances.length === 1 && updaterStarts === 1,
  "the initial Desktop boot did not finish",
);
assert.equal(typeof windowOpenHandler, "function", "the native popup handler was not installed");

if (mode === "happy") {
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
} else if (mode === "store-retry") {
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(() => events.includes("browser.activation"), "activation did not reach the browser");
  resolveActivation();
  await waitFor(
    () => dialogs.some((item) => item.buttons?.includes("Later")),
    "the failed secure save did not offer its bounded retry",
  );
  assert.equal(daemonInstances.length, 1, "an unconfirmed key restarted the daemon");
  assert.ok(envelope?.pending, "an unconfirmed key replaced the durable pending flow");
  assert.deepEqual(windowOpenHandler({ url: MARKER }), { action: "deny" });
  await waitFor(
    () => daemonInstances.length === 2 && dialogs.some((item) => item.title === "Mirafold Pro connected"),
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
    "store.save.key",
    "store.load.key",
    "daemon.stop.0",
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

test("a browser-open failure resumes and reopens the same saved flow only after another trusted marker", linuxOnly, () => {
  runProbe("browser-retry");
});

test("a post-purchase storage failure retries the same key only through the trusted marker", linuxOnly, () => {
  runProbe("store-retry");
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

test("quit closes a resumed activation before stopping the daemon and preserves pending state", linuxOnly, () => {
  runProbe("quit-pending");
});
