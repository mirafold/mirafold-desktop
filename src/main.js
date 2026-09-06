// Mirafold Desktop — the Electron main process.
//
// What this app is: a window that shows the Mirafold UI, and a daemon running
// behind it. That's the whole design. The daemon (see daemon.js) is the real
// product, unmodified and taken straight from the published `mirafold` npm
// package; this process starts it, points a window at it, and cleans up after
// it.
//
// What this app deliberately does NOT add is a renderer bridge. There is no
// preload script, no IPC channel, and no Node access in the page. The window
// loads the same HTTP page a browser would, over loopback, as an ordinary web
// page — so the shell's entire security model (its Content-Security-Policy,
// its per-launch auth token, its Origin guard) stays exactly as true here as it
// is in Chrome. Adding a bridge would mean re-auditing all of it. The native
// parts a desktop app owes you — a real folder picker, a menu, a crash dialog —
// live out here in the main process, where they need no bridge at all.

import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  dialog,
  Menu,
  safeStorage,
  shell,
} from "electron";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBeforeQuitHandler } from "./app-lifecycle.js";
import { Daemon } from "./daemon.js";
import { redactCredentials } from "./daemon-output.js";
import {
  createInterfaceScaleController,
  DEFAULT_INTERFACE_SCALE,
  interfaceScaleShortcut,
} from "./interface-scale.js";
import {
  daemonOriginFromUrl,
  isDesktopActivationRequest,
  navigationVerdict,
  popupVerdict,
} from "./navigation.js";
import { installPermissionGuards } from "./permissions.js";
import { createSafeAppImageUpdater, createSafeNsisUpdater } from "./platform-updaters.js";
import { createProActivationController } from "./pro-activation.js";
import { createProStore, PRO_STORE_VERSION } from "./pro-store.js";
import {
  interfaceScale as savedInterfaceScale,
  lastFolder,
  setInterfaceScale,
  setLastFolder,
} from "./state.js";
import {
  APT_MANAGED_MARKER,
  createDesktopUpdater,
  desktopUpdateStrategy,
} from "./updater.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOADING = path.join(HERE, "loading.html");
const ICON = path.join(HERE, "..", "build", "icon.png");
const require = createRequire(import.meta.url);
const SHELL_VERSION = require("mirafold/package.json").version;

let win = null;
let folder = null;
let daemon = null;
let daemonOrigin = null;
let quitting = false;
let bootSeq = 0;
let folderChangePromise = null;
let desktopUpdater = null;
let interfaceScaleController = null;
let proStore = null;
let proActivation = null;
let proLicenseKey;
let proRetryKey;
let proPendingFlow = false;
let proActionPromise = null;
let proActivationUrl = null;
let proProgress = null;

const PRO_LICENSE_KEY_RE = /^mf_[a-z2-7]{20,40}$/;

/**
 * Start a Promise-returning Electron action from a synchronous event handler.
 * Do not log the URL or Error: either may contain the daemon's auth token.
 */
function runBackgroundAction(action, failureMessage) {
  let result;
  try {
    result = action();
  } catch {
    console.error(failureMessage);
    return;
  }
  void Promise.resolve(result).catch(() => {
    console.error(failureMessage);
  });
}

/** Keep native error dialogs bounded and safe to screenshot or share. */
function safeErrorDetail(error) {
  const message = redactCredentials(String(error?.message ?? error ?? "")).slice(-2000);
  const stderr = redactCredentials(String(error?.stderr ?? "")).slice(-2000);
  return [message, "", stderr].join("\n").trim();
}

function updateWindowTitle() {
  if (!win || win.isDestroyed()) return;
  if (proProgress !== null) {
    win.setTitle(`Mirafold — ${proProgress}`);
    return;
  }
  win.setTitle(folder ? `Mirafold — ${path.basename(folder)}` : "Mirafold");
}

function setProProgress(message) {
  proProgress = message;
  updateWindowTitle();
}

function proFailureCopy(kind, error) {
  let code = null;
  try {
    if (typeof error?.code === "string") code = error.code;
  } catch {
    // Untrusted errors never contribute text to a native activation dialog.
  }
  if (kind === "preflight") {
    return {
      message: "Secure storage is required before Mirafold Pro can open checkout.",
      detail: "Unlock a supported system Secret Service or KWallet, then try again. Your local Mirafold session is still available.",
    };
  }
  if (kind === "store") {
    return {
      message: "Mirafold Pro could not be saved safely on this device.",
      detail: "Your current session is unchanged. Try the secure save again before starting another purchase.",
    };
  }
  if (kind === "startup") {
    return {
      message: "Saved Mirafold Pro state could not be opened safely.",
      detail: "Mirafold started with local sessions only. Its saved Pro state was left unchanged.",
    };
  }
  const detail = code === "timeout" || code === "expired"
    ? "The private browser handoff expired. Open Pro activation from Mirafold again."
    : code === "browser"
      ? "The activation page could not be opened in the system browser."
      : code === "port-unavailable"
        ? "The saved private callback port is in use. Close the other listener, then reopen Mirafold."
        : "The private browser handoff did not complete. Your local Mirafold session is unchanged.";
  return {
    message: "Mirafold Pro activation was not completed.",
    detail,
  };
}

async function showProFailure(kind, error, retryable = false) {
  setProProgress(null);
  if (quitting || !win) return false;
  const copy = proFailureCopy(kind, error);
  try {
    const { response } = await showMessage({
      type: "error",
      title: "Mirafold Pro couldn't connect",
      message: copy.message,
      detail: copy.detail,
      buttons: retryable ? ["Try again", "Later"] : ["OK"],
      defaultId: 0,
      cancelId: retryable ? 1 : 0,
    });
    return retryable && response === 0;
  } catch {
    console.error("Mirafold could not show its Pro activation failure dialog.");
    return false;
  }
}

async function showProSuccess() {
  setProProgress(null);
  if (quitting || !win) return;
  try {
    await showMessage({
      type: "info",
      title: "Mirafold Pro connected",
      message: "Mirafold Pro is connected on this device.",
      detail: "Mirafold restarted securely. Open Pair in Mirafold to connect your phone.",
      buttons: ["OK"],
      defaultId: 0,
    });
  } catch {
    console.error("Mirafold could not show its Pro activation success dialog.");
  }
}

function trackProAction(action) {
  if (proActionPromise) return proActionPromise;
  let tracked;
  tracked = Promise.resolve()
    .then(action)
    .finally(() => {
      if (proActionPromise === tracked) proActionPromise = null;
      setProProgress(null);
    });
  proActionPromise = tracked;
  return tracked;
}

async function initializeProSupport() {
  if (process.platform !== "linux") return { pending: false, error: null };
  try {
    proStore = createProStore({
      safeStorage,
      userDataPath: app.getPath("userData"),
    });
    proActivation = createProActivationController({
      store: proStore,
      openBrowser: (url) => shell.openExternal(url),
    });
  } catch (error) {
    proStore = null;
    proActivation = null;
    return { pending: false, error };
  }

  try {
    const inspection = await proStore.inspect();
    if (inspection?.present !== true) return { pending: false, error: null };
    let state = await proStore.load();
    if (state?.licenseKey !== undefined) {
      if (!PRO_LICENSE_KEY_RE.test(state.licenseKey)) throw new Error("invalid Pro state");
      proLicenseKey = state.licenseKey;
    }
    const pending = Object.hasOwn(state ?? {}, "pending");
    proPendingFlow = pending;
    state = null;
    return { pending, error: null };
  } catch (error) {
    return { pending: false, error };
  }
}

async function refreshProPendingState() {
  if (!proStore) return proPendingFlow;
  try {
    let state = await proStore.load();
    proPendingFlow = Object.hasOwn(state ?? {}, "pending");
    state = null;
  } catch {
    // Retain the last known state. A fixed UI message owns the visible error.
  }
  return proPendingFlow;
}

async function persistActivatedKey(key) {
  if (!proStore || !PRO_LICENSE_KEY_RE.test(key)) {
    await showProFailure("activation", null);
    return false;
  }
  proRetryKey = key;

  while (!quitting && win) {
    setProProgress("Saving Pro access securely…");
    try {
      await proStore.save({ version: PRO_STORE_VERSION, licenseKey: key });
    } catch {
      // A post-rename durability error may still have committed the exact key.
      // The readback below is the authority before any retry or daemon restart.
    }

    let confirmed = false;
    try {
      const stored = await proStore.load();
      confirmed = stored?.version === PRO_STORE_VERSION
        && stored.licenseKey === key
        && !Object.hasOwn(stored, "pending");
    } catch {
      // Report only the fixed native storage message below.
    }
    if (confirmed) break;
    if (!(await showProFailure("store", null, true))) return false;
  }

  if (quitting || !win) return false;
  proLicenseKey = key;
  proRetryKey = undefined;
  proPendingFlow = false;
  key = undefined;
  setProProgress("Restarting with Pro access…");
  const restarted = await restartDaemonForPro();
  if (restarted !== true) return false;
  await showProSuccess();
  return true;
}

async function reopenProActivationPage(url) {
  if (typeof url !== "string" || url.length === 0) {
    await showProFailure("activation", null);
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    await showProFailure("activation", { code: "browser" });
    if (proActionPromise && proActivationUrl === url) {
      setProProgress("Finish Pro activation in your browser");
    }
    return false;
  }
}

async function finishProActivation(handle) {
  const activationUrl = typeof handle?.activationUrl === "string"
    ? handle.activationUrl
    : null;
  proActivationUrl = activationUrl;
  setProProgress("Finish Pro activation in your browser");
  let key;
  try {
    key = await handle.result;
  } catch (error) {
    if (proActivationUrl === activationUrl) proActivationUrl = null;
    await refreshProPendingState();
    if (!quitting) await showProFailure("activation", error);
    return false;
  }
  if (proActivationUrl === activationUrl) proActivationUrl = null;
  return persistActivatedKey(key);
}

function beginProActivation() {
  if (proActionPromise) {
    return proActivationUrl === null
      ? proActionPromise
      : reopenProActivationPage(proActivationUrl);
  }
  return trackProAction(async () => {
    if (!proStore || !proActivation) {
      await showProFailure("preflight", null);
      return false;
    }
    if (proRetryKey !== undefined) return persistActivatedKey(proRetryKey);

    setProProgress("Preparing Pro activation…");
    try {
      await proStore.preflight();
    } catch (error) {
      await showProFailure("preflight", error);
      return false;
    }

    const resuming = proPendingFlow;
    let handle;
    try {
      handle = proPendingFlow
        ? await proActivation.resume()
        : await proActivation.start();
    } catch (error) {
      await refreshProPendingState();
      await showProFailure("activation", error);
      return false;
    }
    if (!handle) {
      proPendingFlow = false;
      try {
        handle = await proActivation.start();
      } catch (error) {
        await refreshProPendingState();
        await showProFailure("activation", error);
        return false;
      }
    }
    proPendingFlow = true;
    if (resuming) {
      const activationUrl = typeof handle?.activationUrl === "string"
        ? handle.activationUrl
        : null;
      proActivationUrl = activationUrl;
      await reopenProActivationPage(activationUrl);
    }
    return finishProActivation(handle);
  });
}

function resumeProActivation() {
  return trackProAction(async () => {
    setProProgress("Resuming Pro activation…");
    let handle;
    try {
      handle = await proActivation.resume();
    } catch (error) {
      await showProFailure("activation", error);
      return false;
    }
    if (!handle) {
      proPendingFlow = false;
      await showProFailure("startup", null);
      return false;
    }
    proPendingFlow = true;
    return finishProActivation(handle);
  });
}

/**
 * Ask for a project folder. Mirafold sessions run in the daemon's working
 * directory, so this single choice is what the terminal version expresses as
 * "run mirafold in the directory you want to work in".
 */
async function pickFolder(title = "Choose a project folder") {
  const options = {
    title,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Open",
    defaultPath: folder ?? app.getPath("home"),
  };
  const { canceled, filePaths } = win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return canceled || !filePaths[0] ? null : filePaths[0];
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    // Keep the native commands and accelerators without presenting generic
    // application chrome as part of Mirafold's interface. Alt reveals it.
    autoHideMenuBar: true,
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
      // Start at the remembered size before first paint; the load listener
      // below reapplies it when a new daemon port creates a new origin.
      zoomFactor: interfaceScaleController?.scale ?? DEFAULT_INTERFACE_SCALE,
    },
  });

  win.webContents.on("did-finish-load", () => interfaceScaleController?.apply());
  win.webContents.on("before-input-event", (event, input) => {
    const command = interfaceScaleShortcut(input);
    if (command === null) return;
    // This event precedes Electron's menu accelerators. Consuming it prevents
    // the displayed accelerator from applying the same command a second time,
    // while also accepting browsers' unshifted Ctrl/Cmd+= convention.
    event.preventDefault();
    if (command === "in") interfaceScaleController?.zoomIn();
    else if (command === "out") interfaceScaleController?.zoomOut();
    else interfaceScaleController?.reset();
  });

  // Install both halves of Electron's default-deny permission policy before
  // this session loads any content. The policy reads daemonOrigin at request
  // time so its sole notification grant follows daemon restarts without ever
  // covering the loading screen, another window, or the prior daemon.
  installPermissionGuards(win.webContents.session, {
    trustedWebContents: win.webContents,
    getDaemonOrigin: () => daemonOrigin,
  });

  // Mirafold's exact new-session link asks for a new browser tab. Desktop owns
  // one window, so keep that request in the window, where it retains this
  // launch's authenticated renderer state. Every other web popup, including a
  // same-daemon link in agent output, belongs in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url, postBody }) => {
    if (isDesktopActivationRequest(
      url,
      win.webContents.getURL(),
      daemonOrigin,
      postBody != null,
    )) {
      runBackgroundAction(
        beginProActivation,
        "Mirafold Pro activation could not be completed.",
      );
      return { action: "deny" };
    }
    const verdict = popupVerdict(url, daemonOrigin, postBody != null);
    if (verdict === "same-window") {
      runBackgroundAction(
        () => win.loadURL(url),
        "Mirafold could not open the requested session in its window.",
      );
    } else if (verdict === "external") {
      runBackgroundAction(
        () => shell.openExternal(url),
        "Mirafold could not open the requested page in the system browser.",
      );
    }
    return { action: "deny" };
  });

  // Apply the same rule to every frame and to server-side redirects. Electron
  // exposes redirects separately from page/user navigation; guarding only one
  // event would let the other leave the daemon origin. External main-frame
  // pages belong in the real browser. External subframes are simply refused.
  const guardNavigation = (event) => {
    const verdict = navigationVerdict(event.url, LOADING, daemonOrigin);
    if (verdict === "allow") return;
    event.preventDefault();
    if (event.isMainFrame && verdict === "external") {
      runBackgroundAction(
        () => shell.openExternal(event.url),
        "Mirafold could not open the requested page in the system browser.",
      );
    }
  };
  win.webContents.on("will-frame-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);

  win.on("closed", () => {
    daemonOrigin = null;
    win = null;
  });

  return win;
}

/**
 * Start (or restart) the daemon in `folder` and point the window at it.
 * Every launch produces a fresh port and a fresh auth token, so the URL is
 * always read from the daemon rather than reconstructed.
 *
 * A quit or folder change can supersede a boot while it is in flight.
 * `bootSeq` makes the newest boot the only one allowed to touch shared state or
 * talk to the user. Every stale path also stops the particular Daemon it
 * created; sequence ownership alone is not process ownership.
 *
 * @returns {Promise<boolean|undefined>} true only after a working daemon page
 *   finishes loading; every superseded, failed, or quitting path returns no
 *   success signal
 */
async function boot() {
  if (quitting || !win) return;
  const seq = ++bootSeq;
  const dir = folder;
  const current = () => seq === bootSeq && !quitting && win !== null;

  daemonOrigin = null;
  try {
    await win.loadFile(LOADING);
  } catch (err) {
    if (!current()) return;
    return onLoadingScreenFailure(err);
  }
  if (!current()) return;

  const booting = new Daemon((info) => onDaemonCrash(booting, info));
  daemon = booting;

  const retire = async () => {
    const clean = await booting.stop();
    if (daemon === booting) {
      daemon = null;
      daemonOrigin = null;
    }
    return clean;
  };

  let url;
  try {
    url = proLicenseKey === undefined
      ? await booting.start(dir)
      : await booting.start(dir, { licenseKey: proLicenseKey });
  } catch (err) {
    await retire();
    if (!current()) return;
    return onBootFailure(err);
  }
  if (!current() || daemon !== booting) {
    await retire();
    return;
  }

  const origin = daemonOriginFromUrl(url);
  if (origin === null) {
    const clean = await retire();
    if (!current()) return;
    if (!clean) return onDaemonCleanupFailure("starting Mirafold");
    return onBootFailure(new Error("The daemon reported an invalid local URL."));
  }

  setLastFolder(dir);
  daemonOrigin = origin;
  try {
    await win.loadURL(url);
  } catch (err) {
    // A failed load does not mean a failed daemon. If the daemon died in the
    // gap between reporting its URL and the page loading, onDaemonCrash owns
    // the report — a dialog here too would stack a second one on its. Only a
    // load failure with the daemon still alive is boot's news; stopping it
    // then also suppresses the crash callback, so exactly one dialog shows.
    if (!current() || daemon !== booting) {
      await retire();
      return;
    }
    if (!booting.running) return;
    const clean = await retire();
    if (!current()) return;
    if (!clean) return onDaemonCleanupFailure("recovering from a page-load failure");
    return onBootFailure(err);
  }
  if (!current() || daemon !== booting || !booting.running) {
    await retire();
    return;
  }
  updateWindowTitle();
  return true;
}

/** Restart the current folder only after a newly activated key is durable. */
async function restartDaemonForPro() {
  if (quitting || !win || !folder) return false;
  ++bootSeq;
  daemonOrigin = null;
  const stopping = daemon;
  daemon = null;
  const clean = stopping ? await stopping.stop() : true;
  if (!clean) {
    await onDaemonCleanupFailure("enabling Mirafold Pro");
    return false;
  }
  if (quitting || !win) return false;
  return (await boot()) === true;
}

/** Swap the open project: stop this daemon, start another elsewhere. */
async function performFolderChange() {
  if (quitting || !win) return;
  const chosen = await pickFolder("Open another project folder");
  if (!chosen || quitting || !win) return;
  ++bootSeq;
  daemonOrigin = null;
  const stopping = daemon;
  daemon = null;
  const clean = stopping ? await stopping.stop() : true;
  if (!clean) return onDaemonCleanupFailure("switching project folders");
  if (quitting || !win) return;
  folder = chosen;
  await boot();
}

function openFolder() {
  if (folderChangePromise) return folderChangePromise;
  folderChangePromise = performFolderChange().finally(() => {
    folderChangePromise = null;
  });
  return folderChangePromise;
}

async function loadAutoUpdater(updateStrategy) {
  // electron-updater is CommonJS. Read either Node's detected named export or
  // the default object so this remains correct across Node/Electron interop
  // changes. Tar archives need AppUpdater's version/feed comparison without a
  // platform installer; directly installable forms use the matching platform
  // updater, with Mirafold's guarded launch/replacement step below.
  const updaterModule = await import("electron-updater");
  if (updateStrategy === "manual-download") {
    const AppUpdater = updaterModule.AppUpdater ?? updaterModule.default?.AppUpdater;
    if (!AppUpdater) throw new Error("electron-updater did not export AppUpdater");
    return new AppUpdater();
  }
  const emitBeforeQuit = () => electronAutoUpdater.emit("before-quit-for-update");
  if (process.platform === "win32") {
    const NsisUpdater = updaterModule.NsisUpdater ?? updaterModule.default?.NsisUpdater;
    if (!NsisUpdater) throw new Error("electron-updater did not export NsisUpdater");
    const MirafoldNsisUpdater = createSafeNsisUpdater(NsisUpdater, {
      emitBeforeQuit,
      openPath: (installerPath) => shell.openPath(installerPath),
    });
    return new MirafoldNsisUpdater();
  }
  if (process.platform === "linux" && typeof process.env.APPIMAGE === "string") {
    const AppImageUpdater = updaterModule.AppImageUpdater ?? updaterModule.default?.AppImageUpdater;
    if (!AppImageUpdater) throw new Error("electron-updater did not export AppImageUpdater");
    const MirafoldAppImageUpdater = createSafeAppImageUpdater(AppImageUpdater, { emitBeforeQuit });
    return new MirafoldAppImageUpdater();
  }
  const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
  if (!autoUpdater) throw new Error("electron-updater did not export autoUpdater");
  return autoUpdater;
}

/** electron-builder writes this marker only into system-package targets. */
function installedLinuxPackageType() {
  if (process.platform !== "linux" || !app.isPackaged) return null;
  try {
    return readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim();
  } catch {
    // AppImage and tar packages deliberately have no marker. Unknown or
    // unreadable forms fail safe to a release notice rather than replacement.
    return null;
  }
}

/** The root-owned archive-keyring package marks repository-managed installs. */
function isAptManagedLinuxInstall() {
  return process.platform === "linux"
    && app.isPackaged
    && existsSync(APT_MANAGED_MARKER);
}

/** A native message box parented to the window while one exists. */
function showMessage(options) {
  return win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options);
}

/**
 * Freeze boots, stop the daemon tree, and prove it is gone before an updater
 * gets permission to open an installer. A failed proof restarts the local
 * daemon and returns false; the updater then keeps the download for later.
 */
async function prepareForUpdateInstall() {
  ++bootSeq;
  daemonOrigin = null;
  const stopping = daemon;
  daemon = null;
  const clean = stopping ? await stopping.stop() : true;
  if (!clean) {
    await onDaemonCleanupFailure("installing an update");
    return false;
  }
  quitting = true;
  return true;
}

/** Restore a working daemon if the platform installer fails before app quit. */
async function recoverFromUpdateInstallFailure() {
  if (!win || !folder) return;
  quitting = false;
  if (!daemon) await boot();
}

async function onBootFailure(err) {
  daemonOrigin = null;
  // Same guard as onDaemonCrash: during quit (or with the window gone) there
  // is no one to ask — a dialog would race app teardown, parentless.
  if (quitting || !win) return;
  const { response } = await showMessage({
    type: "error",
    title: "Mirafold couldn't start",
    message: "The Mirafold daemon failed to start.",
    detail: safeErrorDetail(err),
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

/** A packaged app without its local loading page cannot safely start a daemon. */
async function onLoadingScreenFailure(err) {
  daemonOrigin = null;
  if (quitting || !win) return;
  try {
    await showMessage({
      type: "error",
      title: "Mirafold couldn't start",
      message: "The Mirafold desktop interface could not be loaded.",
      detail: safeErrorDetail(err),
      buttons: ["Quit"],
      defaultId: 0,
    });
  } catch {
    // Do not let a second native failure turn the original startup failure
    // into an unhandled rejection. The app still has no usable interface.
    console.error("Mirafold could not show its startup failure dialog.");
  } finally {
    quitting = true;
    app.quit();
  }
}

async function onDaemonCleanupFailure(action) {
  daemonOrigin = null;
  if (quitting || !win) return;
  try {
    await showMessage({
      type: "error",
      title: "Mirafold couldn't stop safely",
      message: `Mirafold could not prove its background processes stopped while ${action}.`,
      detail: "No replacement daemon or installer was started. Quit Mirafold, then check your system's process list before reopening it.",
      buttons: ["Quit"],
      defaultId: 0,
    });
  } finally {
    // A native-dialog failure cannot authorize a replacement process or leave
    // a disconnected window running after cleanup itself failed.
    quitting = true;
    app.quit();
  }
}

/**
 * The daemon died on its own. This is the case the child-process architecture
 * exists to handle well: the daemon's own crash handler calls process.exit(1),
 * which in-process would have taken this window and every explanation with it.
 * Here it's an exit code, and the user gets the log and a way back.
 */
async function onDaemonCrash(crashed, { code, signal, stderr, clean }) {
  if (daemon !== crashed) return;
  daemon = null;
  daemonOrigin = null;
  if (quitting || !win) return;
  if (clean !== true) return onDaemonCleanupFailure("recovering from a daemon crash");
  const how = signal ? `was killed (${signal})` : `exited with code ${code}`;
  const { response } = await showMessage({
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

export function buildMenu(isPackaged = app.isPackaged) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Project",
        submenu: [
          {
            label: "Open Project Folder…",
            accelerator: "CmdOrCtrl+O",
            click: () => void openFolder(),
          },
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
          ...(!isPackaged ? [{ role: "reload" }] : []),
          {
            label: "Zoom In",
            accelerator: "CmdOrCtrl+Plus",
            click: () => interfaceScaleController?.zoomIn(),
          },
          {
            label: "Zoom Out",
            accelerator: "CmdOrCtrl+-",
            click: () => interfaceScaleController?.zoomOut(),
          },
          {
            label: "Actual Size",
            accelerator: "CmdOrCtrl+0",
            click: () => interfaceScaleController?.reset(),
          },
          { type: "separator" },
          { role: "togglefullscreen" },
          ...(!isPackaged ? [{ role: "toggleDevTools" }] : []),
        ],
      },
      {
        label: "Help",
        submenu: desktopUpdater.helpMenuItems(),
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
    interfaceScaleController = createInterfaceScaleController({
      initialScale: savedInterfaceScale(),
      applyScale(scale) {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        win.webContents.setZoomFactor(scale);
      },
      persistScale: setInterfaceScale,
    });
    const updateStrategy = desktopUpdateStrategy({
      isPackaged: app.isPackaged,
      isWindowsStore: process.windowsStore === true,
      platform: process.platform,
      isAppImage: typeof process.env.APPIMAGE === "string",
      linuxPackageType: installedLinuxPackageType(),
      isAptManaged: isAptManagedLinuxInstall(),
    });
    desktopUpdater = createDesktopUpdater({
      isPackaged: app.isPackaged,
      // Electron exposes this only after ready. MSIX/AppX packages belong to
      // the Microsoft Store update channel and must never contact ours.
      isWindowsStore: process.windowsStore === true,
      desktopVersion: app.getVersion(),
      shellVersion: SHELL_VERSION,
      updateStrategy,
      loadUpdater: () => loadAutoUpdater(updateStrategy),
      showMessage,
      openDownloadPage: (url) => shell.openExternal(url),
      prepareInstall: prepareForUpdateInstall,
      recoverInstall: recoverFromUpdateInstallFailure,
      logger: console,
    });
    buildMenu();
    folder = lastFolder() ?? (await pickFolder());
    // Nothing to open and nothing chosen — the user cancelled the only question
    // this app asks. Leaving an empty window up would be worse than exiting.
    if (!folder) return app.quit();
    createWindow();
    const proStartup = await initializeProSupport();
    const booted = await boot();
    if (booted !== true || quitting || !win) return;
    if (proStartup.error) {
      await showProFailure("startup", proStartup.error);
    } else if (proStartup.pending) {
      runBackgroundAction(
        resumeProActivation,
        "Mirafold Pro activation could not be resumed.",
      );
    }
    // Updating is background work. A missing feed or network failure is logged
    // and never delays or tears down a working Mirafold session.
    void desktopUpdater.start();
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
  const handleBeforeQuit = createBeforeQuitHandler({
    beginQuit() {
      quitting = true;
      daemonOrigin = null;
    },
    async stop() {
      const activation = proActivation;
      const proAction = proActionPromise;
      if (activation) await activation.shutdown();
      if (proAction) await proAction;
      const stopping = daemon;
      daemon = null;
      if (stopping && (await stopping.stop()) !== true) {
        throw new Error("Mirafold could not prove that its daemon process tree stopped");
      }
    },
    finishQuit: () => app.quit(),
    reportError: (error) => console.error("Mirafold quit cleanup failed:", error),
  });
  app.on("before-quit", (event) => void handleBeforeQuit(event));
}
