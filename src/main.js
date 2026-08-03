// Mirafold Desktop — the Electron main process.
//
// What this app is: a window that shows the Mirafold UI, and a daemon running
// behind it. That's the whole design. The daemon (see daemon.js) is the real
// product, unmodified and taken straight from the published `mirafold` npm
// package; this process starts it, points a window at it, and cleans up after
// it.
//
// What this app deliberately is NOT: an integration. There is no preload
// script, no IPC channel, and no Node access in the page. The window loads the
// same HTTP page a browser would, over loopback, as an ordinary web page — so
// the shell's entire security model (its Content-Security-Policy, its
// per-launch auth token, its Origin guard) stays exactly as true here as it is
// in Chrome. Adding a bridge would mean re-auditing all of it. The native parts
// a desktop app owes you — a real folder picker, a menu, a crash dialog — live
// out here in the main process, where they need no bridge at all.

import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "./daemon.js";
import { lastFolder, setLastFolder } from "./state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADING = path.join(HERE, "loading.html");
const ICON = path.join(HERE, "..", "build", "icon.png");

let win = null;
let folder = null;
let daemon = null;
let quitting = false;
let bootSeq = 0;

/**
 * Ask for a project folder. Mirafold sessions run in the daemon's working
 * directory, so this single choice is what the terminal version expresses as
 * "run mirafold in the directory you want to work in".
 */
async function pickFolder(title = "Choose a project folder") {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Open",
    defaultPath: folder ?? app.getPath("home"),
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0a0d13", // matches the shell's surface, so no white flash
    icon: ICON, // used on Linux; Windows takes it from the packaged executable
    show: true,
    webPreferences: {
      // Electron's secure defaults, stated rather than assumed — the page is
      // remote-ish content (it is served over HTTP, and it renders whatever an
      // agent writes) and must never reach Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links in agent output belong in the user's real browser, not in a second
  // window of this app with no address bar and no way to see where it went.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Same rule for in-page navigation: this window shows the daemon and nothing
  // else. Anything else is either a mistake or something that should have been
  // an external link.
  win.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    if (target.hostname !== "127.0.0.1" && target.protocol !== "file:") {
      event.preventDefault();
      if (/^https?:$/.test(target.protocol)) void shell.openExternal(url);
    }
  });

  win.on("closed", () => {
    win = null;
  });

  return win;
}

/**
 * Start (or restart) the daemon in `folder` and point the window at it.
 * Every launch produces a fresh port and a fresh auth token, so the URL is
 * always read from the daemon rather than reconstructed.
 *
 * Boots can overlap: File → Open Folder during a slow boot, or a quit while
 * one is in flight. `bootSeq` makes the newest boot the only one allowed to
 * touch shared state or talk to the user — a superseded boot's daemon was
 * already stopped by whoever superseded it, so its failure is expected noise,
 * not news. Without this, that stale failure nulled the live `daemon`
 * reference (orphaning the new daemon past quit) and raised a spurious
 * "couldn't start" dialog over a working session.
 */
async function boot() {
  const seq = ++bootSeq;
  const dir = folder;
  const current = () => seq === bootSeq && !quitting && win !== null;

  await win.loadFile(LOADING);
  if (!current()) return;

  const booting = new Daemon(onDaemonCrash);
  daemon = booting;

  let url;
  try {
    url = await booting.start(dir);
  } catch (err) {
    if (!current()) return;
    daemon = null;
    return onBootFailure(err);
  }
  if (!current()) return;

  setLastFolder(dir);
  try {
    await win.loadURL(url);
  } catch (err) {
    // A failed load does not mean a failed daemon. If the daemon died in the
    // gap between reporting its URL and the page loading, onDaemonCrash owns
    // the report — a dialog here too would stack a second one on its. Only a
    // load failure with the daemon still alive is boot's news; stopping it
    // then also suppresses the crash callback, so exactly one dialog shows.
    if (!current() || !booting.running) return;
    booting.stop();
    daemon = null;
    return onBootFailure(err);
  }
  win.setTitle(`Mirafold — ${path.basename(dir)}`);
}

/** Swap the open project: stop this daemon, start another elsewhere. */
async function openFolder() {
  const chosen = await pickFolder("Open another project folder");
  if (!chosen) return;
  daemon?.stop();
  daemon = null;
  folder = chosen;
  await boot();
}

async function onBootFailure(err) {
  // Same guard as onDaemonCrash: during quit (or with the window gone) there
  // is no one to ask — a dialog would race app teardown, parentless.
  if (quitting || !win) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "error",
    title: "Mirafold couldn't start",
    message: "The Mirafold daemon failed to start.",
    detail: [err.message, "", (err.stderr ?? "").slice(-2000)].join("\n").trim(),
    buttons: ["Try again", "Choose another folder", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) return boot();
  if (response === 1) {
    const chosen = await pickFolder();
    if (chosen) {
      folder = chosen;
      return boot();
    }
  }
  quitting = true;
  app.quit();
}

/**
 * The daemon died on its own. This is the case the child-process architecture
 * exists to handle well: the daemon's own crash handler calls process.exit(1),
 * which in-process would have taken this window and every explanation with it.
 * Here it's an exit code, and the user gets the log and a way back.
 */
async function onDaemonCrash({ code, signal, stderr }) {
  daemon = null;
  if (quitting || !win) return;
  const how = signal ? `was killed (${signal})` : `exited with code ${code}`;
  const { response } = await dialog.showMessageBox(win, {
    type: "error",
    title: "Mirafold stopped",
    message: `The Mirafold daemon ${how}.`,
    detail: [
      "Your window is still open, but it is no longer connected to a running",
      "session. Restarting starts a fresh daemon in the same folder.",
      "",
      "Details are also written to the Mirafold log file.",
      "",
      stderr.slice(-2000),
    ]
      .join("\n")
      .trim(),
    buttons: ["Restart", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) return boot();
  quitting = true;
  app.quit();
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void openFolder() },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
          { role: "toggleDevTools" },
        ],
      },
    ]),
  );
}

// One instance per machine. A second launch would otherwise start a second
// daemon, and the two would fight over ports and over the same project folder's
// agent state. Instead, focus the window that already exists.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    buildMenu();
    folder = lastFolder() ?? (await pickFolder());
    // Nothing to open and nothing chosen — the user cancelled the only question
    // this app asks. Leaving an empty window up would be worse than exiting.
    if (!folder) return app.quit();
    createWindow();
    await boot();
  });

  // We target Linux and Windows, where closing the last window means quitting.
  // (macOS's keep-running-with-no-windows convention would also mean keeping a
  // daemon and its agent processes alive invisibly — worth revisiting only if
  // macOS ships.)
  app.on("window-all-closed", () => {
    quitting = true;
    app.quit();
  });

  // The daemon and every agent CLI beneath it go down with us. Without this the
  // user quits the app and leaves processes running that they cannot see.
  app.on("before-quit", () => {
    quitting = true;
    daemon?.stop();
    daemon = null;
  });
}
