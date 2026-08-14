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

const daemonInstances = [];
const rememberedFolders = [];
const messages = [];
const windows = [];
const openedExternally = [];
const permissionInstalls = { check: 0, request: 0 };
let windowOpenHandler = null;
const mode = process.env.MIRAFOLD_MAIN_PROBE_MODE;
let folderDialogs = 0;
let menuTemplate = null;
let failStops = false;
let quitCalls = 0;
let releaseStaleStart;
const staleStart = new Promise((resolve) => { releaseStaleStart = resolve; });

class FakeDaemon {
  constructor(onCrash) {
    this.onCrash = onCrash;
    this.running = false;
    this.stopCalls = 0;
    daemonInstances.push(this);
  }

  async start(folder) {
    this.folder = folder;
    this.running = true;
    if (daemonInstances.indexOf(this) === 2) await staleStart;
    return "http://127.0.0.1:" + (4100 + daemonInstances.indexOf(this)) + "/?token=fixture ";
  }

  async stop() {
    this.stopCalls += 1;
    if (failStops) return false;
    this.running = false;
    return true;
  }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.session = {
      setPermissionCheckHandler() { permissionInstalls.check += 1; },
      setPermissionRequestHandler() { permissionInstalls.request += 1; },
    };
    this.webContents.setWindowOpenHandler = (handler) => { windowOpenHandler = handler; };
    windows.push(this);
  }

  async loadFile() {}
  async loadURL() {
    if (mode !== "crash-during-load") return;
    // The v0.1.1 bug's exact ordering: the daemon dies right after reporting
    // its URL, so the page load REJECTS FIRST and the crash callback lands
    // afterwards — boot() must stay silent and let the crash report own the
    // only dialog. (Delivering the crash before the rejection would let the
    // daemon-identity guard absorb it and would not exercise this fix.)
    const crashed = daemonInstances[0];
    crashed.running = false;
    setImmediate(() => crashed.onCrash({ code: 1, signal: null, stderr: "fixture crash after URL", clean: true }));
    throw new Error("page load failed after the daemon crashed");
  }
  setTitle(value) { this.title = value; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() {}
  focus() {}
}

const app = new EventEmitter();
app.isPackaged = false;
app.requestSingleInstanceLock = () => true;
app.whenReady = () => Promise.resolve();
app.getPath = () => "/fixture-home";
app.getVersion = () => "0.1.1";
app.quit = () => { quitCalls += 1; };

const autoUpdater = new EventEmitter();
const dialog = {
  async showOpenDialog(...args) {
    folderDialogs += 1;
    assert.ok(args[0] instanceof FakeWindow, "an active window must own the folder dialog");
    return { canceled: false, filePaths: ["/next-project"] };
  },
  async showMessageBox(...args) {
    if (mode !== "cleanup-failure" && mode !== "crash-during-load") {
      throw new Error("no error dialog was expected");
    }
    messages.push(args);
    // cleanup-failure offers only Quit (0). crash-during-load answers Quit on
    // the expected crash dialog (1) and also Quit (2) on the boot-failure
    // dialog that only a regression would show, so a broken guard terminates
    // instead of looping through folder pickers.
    if (mode !== "crash-during-load") return { response: 0 };
    return { response: args[1].title === "Mirafold stopped" ? 1 : 2 };
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
  async openExternal(url) { openedExternally.push(url); },
  async openPath() { return ""; },
};

mock.module("electron", {
  namedExports: { app, autoUpdater, BrowserWindow: FakeWindow, dialog, Menu, shell },
});
mock.module(new URL("./src/daemon.js", import.meta.url).href, {
  namedExports: { Daemon: FakeDaemon },
});
mock.module(new URL("./src/state.js", import.meta.url).href, {
  namedExports: {
    lastFolder: () => "/initial-project",
    setLastFolder: (folder) => rememberedFolders.push(folder),
  },
});

await import(new URL("./src/main.js?folder-race-probe", import.meta.url));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

await waitFor(
  () => menuTemplate !== null && daemonInstances.length === 1
    && (mode === "crash-during-load" || daemonInstances[0].running),
  "initial daemon did not finish booting",
);
const openFolder = menuTemplate.find((item) => item.label === "File").submenu[0].click;

if (mode === "crash-during-load") {
  // Pins the v0.1.1 bug: a daemon dying right after reporting its URL made
  // BOTH onDaemonCrash and the page-load failure path report, stacking two
  // dialogs. Exactly one dialog — the crash report — may appear.
  await waitFor(() => quitCalls === 1, "a crash during page load did not settle");
  assert.equal(messages.length, 1, "exactly one dialog must report a crash during page load");
  assert.equal(messages[0][1].title, "Mirafold stopped");
  assert.equal(daemonInstances.length, 1, "no replacement daemon may start after Quit");
  assert.equal(daemonInstances[0].running, false);
  process.stdout.write("main lifecycle probe passed\n");
} else if (mode === "cleanup-failure") {
  failStops = true;
  openFolder();
  await waitFor(() => quitCalls === 1, "cleanup failure did not force a safe quit");
  assert.equal(folderDialogs, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0][1].title, "Mirafold couldn't stop safely");
  assert.equal(daemonInstances.length, 1, "an unproven stop launched a replacement daemon");
  assert.equal(daemonInstances[0].running, true, "the fixture must model an unproven live daemon");
  assert.deepEqual(rememberedFolders, ["/initial-project"]);
  process.stdout.write("main lifecycle probe passed\n");
} else {
// The window-security wiring. The navigation and permission RULES are unit
// tested (navigation.test.js, permissions.test.js), but pinned here is that
// the real window actually consults them — 2026-08-14 test audit: deleting
// the will-redirect guard, the installPermissionGuards call, or denying
// nothing in the window-open handler each left the entire suite green.
assert.equal(permissionInstalls.check, 1, "the permission check handler was not installed");
assert.equal(permissionInstalls.request, 1, "the permission request handler was not installed");
assert.equal(typeof windowOpenHandler, "function", "no window-open handler was installed");
assert.deepEqual(windowOpenHandler({ url: "https://example.com/" }), { action: "deny" });
assert.deepEqual(windowOpenHandler({ url: "javascript:alert(1)" }), { action: "deny" });
assert.deepEqual(
  openedExternally,
  ["https://example.com/"],
  "a web popup goes to the real browser exactly once; unsafe schemes never do",
);
openedExternally.length = 0;

const guardedWindow = windows[0];
for (const eventName of ["will-frame-navigate", "will-redirect"]) {
  let prevented = 0;
  const preventDefault = () => { prevented += 1; };
  guardedWindow.webContents.emit(eventName, { url: "https://example.com/page", isMainFrame: true, preventDefault });
  assert.equal(prevented, 1, eventName + " must stop an external main-frame navigation");
  guardedWindow.webContents.emit(eventName, { url: "https://example.com/frame", isMainFrame: false, preventDefault });
  assert.equal(prevented, 2, eventName + " must refuse an external subframe");
  guardedWindow.webContents.emit(eventName, { url: "http://127.0.0.1:4100/session/1", isMainFrame: true, preventDefault });
  assert.equal(prevented, 2, eventName + " must allow this daemon's own origin");
}
assert.deepEqual(
  openedExternally,
  ["https://example.com/page", "https://example.com/page"],
  "external main-frame navigations open in the real browser; subframes are simply refused",
);
openedExternally.length = 0;

openFolder();
openFolder();

await waitFor(
  () => daemonInstances.length === 2 && daemonInstances[1].running,
  "folder replacement did not finish booting",
);
await new Promise((resolve) => setImmediate(resolve));

assert.equal(folderDialogs, 1, "rapid commands must share one folder change");
assert.equal(daemonInstances.length, 2, "rapid commands must not launch two replacements");
assert.equal(daemonInstances[0].stopCalls, 1, "the prior daemon must stop exactly once");
assert.equal(daemonInstances[0].running, false, "the prior daemon remained live");
assert.equal(daemonInstances[1].running, true, "the replacement daemon is not live");
assert.deepEqual(rememberedFolders, ["/initial-project", "/next-project"]);

// A later successful start that is superseded by quit must retire itself. The
// old sequence guard returned here without stopping this exact Daemon.
openFolder();
await waitFor(
  () => daemonInstances.length === 3 && daemonInstances[2].running,
  "stale-start fixture did not begin",
);
app.emit("window-all-closed");
releaseStaleStart();
await waitFor(
  () => daemonInstances[2].stopCalls === 1,
  "superseded successful boot did not retire its own daemon",
);
assert.equal(daemonInstances[1].running, false, "the second prior daemon remained live");
assert.equal(daemonInstances[2].running, false, "the superseded daemon remained live");
assert.deepEqual(
  rememberedFolders,
  ["/initial-project", "/next-project"],
  "a stale boot must not persist its folder",
);
process.stdout.write("main lifecycle probe passed\n");
}
`;

function runProbe(mode) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "--eval", PROBE],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MIRAFOLD_MAIN_PROBE_MODE: mode },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  assert.match(result.stdout, /main lifecycle probe passed/);
}

test("rapid folder changes coalesce and a superseded successful boot retires itself", () => {
  runProbe("race");
});

test("an unproven daemon stop starts no replacement and forces a safe quit", () => {
  runProbe("cleanup-failure");
});

test("a daemon crash during the page load produces exactly one dialog", () => {
  runProbe("crash-during-load");
});
