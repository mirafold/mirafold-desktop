import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PROBE = String.raw`
import { EventEmitter } from "node:events";
import * as realFs from "node:fs";
import { mock } from "node:test";
import assert from "node:assert/strict";

const daemonInstances = [];
const rememberedFolders = [];
const messages = [];
const windows = [];
const openedExternally = [];
const unhandledRejections = [];
const backgroundErrors = [];
const permissionInstalls = { check: 0, request: 0 };
let permissionCheckHandler = null;
let permissionRequestHandler = null;
let windowOpenHandler = null;
const mode = process.env.MIRAFOLD_MAIN_PROBE_MODE;
if (mode === "apt-managed") process.resourcesPath = "/fixture-resources";
if (mode === "navigation-rejection" || mode === "loading-file-failure") {
  process.on("unhandledRejection", (error) => { unhandledRejections.push(error); });
}
if (mode === "navigation-rejection") {
  console.error = (...args) => { backgroundErrors.push(args); };
}
let folderDialogs = 0;
let menuTemplate = null;
let failStops = false;
let quitCalls = 0;
let updaterStarts = 0;
let releaseStaleStart;
const staleStart = new Promise((resolve) => { releaseStaleStart = resolve; });
const { default: realFsDefault, ...realFsNamed } = realFs;

mock.module("node:fs", {
  defaultExport: realFsDefault,
  namedExports: {
    ...realFsNamed,
    existsSync(file) {
      if (mode === "apt-managed" && file === "/usr/share/mirafold/apt-managed") return true;
      return realFs.existsSync(file);
    },
    readFileSync(file, ...args) {
      if (mode === "apt-managed" && String(file).endsWith("/package-type")) return "deb\n";
      return realFs.readFileSync(file, ...args);
    },
  },
});

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
    if (
      mode === "boot-failure-quit"
      || (mode === "boot-failure-retry" && daemonInstances.indexOf(this) === 0)
    ) {
      this.running = false;
      throw new Error("fixture daemon startup failure");
    }
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
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.loadedUrls = [];
    this.webContents = new EventEmitter();
    this.webContents.session = {
      setPermissionCheckHandler(handler) {
        permissionInstalls.check += 1;
        permissionCheckHandler = handler;
      },
      setPermissionRequestHandler(handler) {
        permissionInstalls.request += 1;
        permissionRequestHandler = handler;
      },
    };
    this.webContents.setWindowOpenHandler = (handler) => { windowOpenHandler = handler; };
    windows.push(this);
  }

  async loadFile() {
    if (mode === "loading-file-failure") {
      throw new Error("fixture loading screen failure");
    }
  }
  async loadURL(url) {
    this.loadedUrls.push(url);
    if (mode === "page-load-failure") {
      const failure = new Error(
        "ERR_FAILED (-2) loading 'http://127.0.0.1:4100/?token=dummy-dialog-token'",
      );
      failure.stderr = "pairing code: dummy-pairing-code";
      throw failure;
    }
    if (mode === "navigation-rejection" && url.includes("?new=1")) {
      throw new Error("fixture popup navigation rejection with ?token=secret");
    }
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
app.isPackaged = mode === "apt-managed";
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
    if (
      mode !== "cleanup-failure"
      && mode !== "crash-during-load"
      && mode !== "boot-failure-quit"
      && mode !== "boot-failure-retry"
      && mode !== "loading-file-failure"
      && mode !== "page-load-failure"
    ) {
      throw new Error("no error dialog was expected");
    }
    messages.push(args);
    // cleanup-failure offers only Quit (0). crash-during-load answers Quit on
    // the expected crash dialog (1) and also Quit (2) on the boot-failure
    // dialog that only a regression would show, so a broken guard terminates
    // instead of looping through folder pickers.
    if (mode === "boot-failure-retry") return { response: 0 };
    if (mode === "boot-failure-quit" || mode === "page-load-failure") return { response: 2 };
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
  async openExternal(url) {
    openedExternally.push(url);
    if (mode === "navigation-rejection") {
      throw new Error("fixture external-open rejection");
    }
  },
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
const realUpdater = await import(new URL("./src/updater.js?main-probe-real", import.meta.url));
mock.module(new URL("./src/updater.js", import.meta.url).href, {
  namedExports: {
    ...realUpdater,
    createDesktopUpdater(options) {
      const updater = realUpdater.createDesktopUpdater(options);
      return {
        ...updater,
        start() {
          updaterStarts += 1;
          return Promise.resolve(null);
        },
      };
    },
  },
});

const mainModule = await import(new URL("./src/main.js?folder-race-probe", import.meta.url));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

await waitFor(
  () => menuTemplate !== null && (
    mode === "loading-file-failure"
      ? quitCalls === 1 || unhandledRejections.length === 1
      : mode === "boot-failure-retry"
        ? daemonInstances.length === 2 && daemonInstances[1].running
        : daemonInstances.length === 1
        && (
          mode === "crash-during-load"
          || mode === "boot-failure-quit"
          || mode === "page-load-failure"
          || daemonInstances[0].running
        )
  ),
  "initial daemon did not finish booting",
);
assert.equal(windows[0].options.autoHideMenuBar, true, "the native menu bar must start hidden");
assert.deepEqual(menuTemplate.map((item) => item.label), ["Project", "Edit", "View", "Help"]);
const projectMenu = menuTemplate.find((item) => item.label === "Project");
assert.equal(projectMenu.submenu[0].label, "Open Project Folder…");
const openFolder = projectMenu.submenu[0].click;
const developmentViewRoles = menuTemplate
  .find((item) => item.label === "View")
  .submenu.map((item) => item.role)
  .filter(Boolean);
assert.deepEqual(
  developmentViewRoles,
  mode === "apt-managed"
    ? ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]
    : ["reload", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "toggleDevTools"],
);

if (
  mode !== "crash-during-load"
  && mode !== "boot-failure-quit"
  && mode !== "page-load-failure"
  && mode !== "loading-file-failure"
) {
  await waitFor(() => updaterStarts === 1, "a successful boot did not start the updater");
  assert.equal(updaterStarts, 1, "a successful boot must start the updater exactly once");
}

if (mode === "apt-managed") {
  const helpItem = menuTemplate.find((item) => item.label === "Help").submenu[0];
  assert.equal(helpItem.label, "Updates managed by APT");
  assert.equal(helpItem.enabled, false);
  process.stdout.write("main lifecycle probe passed\n");
} else if (mode === "packaged-menu") {
  mainModule.buildMenu(true);
  const packagedViewRoles = menuTemplate
    .find((item) => item.label === "View")
    .submenu.map((item) => item.role)
    .filter(Boolean);
  assert.deepEqual(
    packagedViewRoles,
    ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"],
    "packaged builds must not present reload or developer tools as product commands",
  );
  process.stdout.write("main lifecycle probe passed\n");
} else if (mode === "crash-during-load") {
  // Pins the v0.1.1 bug: a daemon dying right after reporting its URL made
  // BOTH onDaemonCrash and the page-load failure path report, stacking two
  // dialogs. Exactly one dialog — the crash report — may appear.
  await waitFor(() => quitCalls === 1, "a crash during page load did not settle");
  assert.equal(messages.length, 1, "exactly one dialog must report a crash during page load");
  assert.equal(messages[0][1].title, "Mirafold stopped");
  assert.equal(daemonInstances.length, 1, "no replacement daemon may start after Quit");
  assert.equal(daemonInstances[0].running, false);
  assert.equal(updaterStarts, 0, "the updater must not start before the deferred crash report settles");
  process.stdout.write("main lifecycle probe passed\n");
} else if (mode === "boot-failure-quit") {
  await waitFor(() => quitCalls === 1, "Quit from the boot-failure dialog did not settle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1, "the failed boot must show exactly one dialog");
  assert.equal(messages[0][1].title, "Mirafold couldn't start");
  assert.equal(daemonInstances.length, 1, "Quit must not launch a replacement daemon");
  assert.equal(daemonInstances[0].running, false);
  assert.equal(updaterStarts, 0, "the updater must not start after the user chose Quit");
  process.stdout.write("main lifecycle probe passed\n");
} else if (mode === "boot-failure-retry") {
  assert.equal(messages.length, 1, "the first failed boot must show exactly one dialog");
  assert.equal(messages[0][1].title, "Mirafold couldn't start");
  assert.equal(daemonInstances.length, 2, "Try again must launch one replacement daemon");
  assert.equal(daemonInstances[0].running, false, "the failed daemon must remain stopped");
  assert.equal(daemonInstances[1].running, true, "the retried daemon must be running");
  assert.equal(quitCalls, 0, "a successful retry must keep the app open");
  assert.equal(updaterStarts, 1, "the successful retry must start the updater exactly once");
  process.stdout.write("main lifecycle probe passed\n");
} else if (mode === "page-load-failure") {
  await waitFor(() => quitCalls === 1, "Quit from the page-load failure dialog did not settle");
  assert.equal(messages.length, 1, "the page-load failure must show exactly one dialog");
  assert.equal(messages[0][1].title, "Mirafold couldn't start");
  const detail = messages[0][1].detail;
  assert.doesNotMatch(detail, /dummy-dialog-token/, "the daemon token escaped into the dialog");
  assert.doesNotMatch(detail, /dummy-pairing-code/, "the pairing code escaped into the dialog");
  assert.match(detail, /token=<redacted>/, "the token location should remain intelligible");
  assert.match(detail, /pairing code: <redacted>/, "the pairing-code location should remain intelligible");
  assert.equal(daemonInstances[0].running, false, "the failed page-load daemon must be stopped");
  assert.equal(updaterStarts, 0, "the updater must not start after a page-load failure");
  process.stdout.write("main lifecycle probe passed\n");
} else if (mode === "loading-file-failure") {
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandledRejections, [], "the loading-screen failure must be handled");
  assert.equal(quitCalls, 1, "a missing loading screen must quit cleanly");
  assert.equal(messages.length, 1, "the loading-screen failure must show exactly one dialog");
  assert.equal(messages[0][1].title, "Mirafold couldn't start");
  assert.equal(messages[0][1].message, "The Mirafold desktop interface could not be loaded.");
  assert.equal(daemonInstances.length, 0, "no daemon may start without the loading interface");
  assert.equal(updaterStarts, 0, "the updater must not start after a loading-screen failure");
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
assert.equal(
  permissionCheckHandler(
    windows[0].webContents,
    "notifications",
    "http://127.0.0.1:4100/",
    { requestingUrl: "http://127.0.0.1:4100/session/1", isMainFrame: true },
  ),
  true,
  "the active daemon window must receive notification permission",
);
let notificationRequestAllowed = null;
permissionRequestHandler(
  windows[0].webContents,
  "notifications",
  (allowed) => { notificationRequestAllowed = allowed; },
  { requestingUrl: "http://127.0.0.1:4100/session/1", isMainFrame: true },
);
assert.equal(notificationRequestAllowed, true, "the active daemon's notification request must be allowed");
assert.equal(typeof windowOpenHandler, "function", "no window-open handler was installed");
const sameDaemonNewSession = "http://127.0.0.1:4100/?new=1";
assert.deepEqual(windowOpenHandler({ url: sameDaemonNewSession }), { action: "deny" });
await waitFor(
  () => windows[0].loadedUrls.at(-1) === sameDaemonNewSession,
  "a same-daemon new-session popup must replace the current desktop view",
);
assert.deepEqual(openedExternally, [], "a same-daemon popup must not escape to the system browser");
const loadsAfterNewSession = windows[0].loadedUrls.length;
const sameDaemonMarkdownLink = "http://127.0.0.1:4100/";
assert.deepEqual(windowOpenHandler({ url: sameDaemonMarkdownLink }), { action: "deny" });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  windows[0].loadedUrls.length,
  loadsAfterNewSession,
  "a same-origin rendered link must not replace the desktop view",
);
assert.deepEqual(
  openedExternally,
  [sameDaemonMarkdownLink],
  "a same-origin rendered link belongs in the system browser",
);
openedExternally.length = 0;
assert.deepEqual(
  windowOpenHandler({ url: sameDaemonNewSession, postBody: { data: [] } }),
  { action: "deny" },
);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(
  windows[0].loadedUrls.length,
  loadsAfterNewSession,
  "a new-window POST must not be converted into a bodyless in-window GET",
);
assert.deepEqual(openedExternally, [], "a new-window POST must not be forwarded without its body");
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

if (mode === "navigation-rejection") {
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandledRejections, [], "navigation failures must not escape as unhandled rejections");
  const navigationErrors = backgroundErrors.filter((args) => (
    String(args[0]).startsWith("Mirafold could not")
  ));
  assert.equal(navigationErrors.length, 5, "each failed background navigation must be reported once");
  assert.ok(
    navigationErrors.every((args) => !args.join(" ").includes("token=secret")),
    "background diagnostics must not expose authenticated daemon URLs",
  );
}

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

test("a successful boot starts one updater while later folder changes remain serialized", () => {
  runProbe("race");
});

test("an unproven daemon stop starts no replacement and forces a safe quit", () => {
  runProbe("cleanup-failure");
});

test("a daemon crash during the page load produces exactly one dialog", () => {
  runProbe("crash-during-load");
});

test("choosing Quit after a boot failure does not start the updater", () => {
  runProbe("boot-failure-quit");
});

test("a successful retry after a boot failure starts the updater exactly once", () => {
  runProbe("boot-failure-retry");
});

test("a page-load failure cannot expose daemon credentials in its dialog", () => {
  runProbe("page-load-failure");
});

test("a loading-screen failure is reported and quits without an unhandled rejection", () => {
  runProbe("loading-file-failure");
});

test("rejected popup and external navigation promises are handled", () => {
  runProbe("navigation-rejection");
});

test("the native menu auto-hides and packaged builds omit development commands", () => {
  runProbe("packaged-menu");
});

test("a packaged Debian install with the archive marker leaves updates to APT", {
  skip: process.platform !== "linux",
}, () => {
  runProbe("apt-managed");
});
