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
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
    };
    this.webContents.setWindowOpenHandler = () => {};
  }

  async loadFile() {}
  async loadURL() {}
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
    if (mode !== "cleanup-failure") throw new Error("no error dialog was expected");
    messages.push(args);
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
  async openExternal() {},
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
  () => menuTemplate !== null && daemonInstances.length === 1 && daemonInstances[0].running,
  "initial daemon did not finish booting",
);
const openFolder = menuTemplate.find((item) => item.label === "File").submenu[0].click;

if (mode === "cleanup-failure") {
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
