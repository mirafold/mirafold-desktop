// Mirafold Desktop's update policy, kept separate from Electron's main process
// so every state transition can be tested without contacting a release feed or
// starting an installer.
//
// `electron-updater` owns the security-sensitive protocol and platform work:
// release metadata, SHA-512 verification, differential downloads, NSIS
// signature checks when the app is signed, and the actual NSIS/AppImage/Linux
// package installation. This module owns Mirafold's product policy around it:
// no development or Microsoft Store checks, no surprise restart, and no
// installer until the daemon process tree is confirmed gone.

const DIAGNOSTIC_CHARS = 2000;
export const DOWNLOAD_PAGE_URL = "https://github.com/mirafold/mirafold-desktop/releases/latest";

/**
 * Decide which update mechanism this exact installed form can safely use.
 *
 * AppImage's runtime identifies itself with APPIMAGE. electron-builder puts a
 * `package-type` file containing `deb` in an installed Debian package. The
 * tar archive has neither marker: its files may have been extracted anywhere,
 * so replacing that tree while it is running has no safe general solution.
 */
export function desktopUpdateStrategy({
  isPackaged,
  isWindowsStore,
  platform,
  isAppImage = false,
  linuxPackageType = null,
}) {
  if (isPackaged !== true) return "disabled";
  if (isWindowsStore === true) return "store";
  if (platform !== "linux") return "install";
  if (isAppImage || linuxPackageType === "deb") return "install";
  return "manual-download";
}

/** Keep updater diagnostics useful without persisting URL credentials or IDs. */
export function sanitizeUpdateDiagnostic(value) {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/([?&](?:access_token|auth|key|token)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(\buser id:\s*)[0-9a-f-]{16,}/gi, "$1<redacted>")
    .slice(0, DIAGNOSTIC_CHARS);
}

/** Direct installers update only packaged, non-Store applications. */
export function shouldUseDesktopUpdater({ isPackaged, isWindowsStore }) {
  return isPackaged === true && isWindowsStore !== true;
}

function createSafeLogger(logger) {
  const write = (level, values) => {
    const target = logger?.[level] ?? logger?.info;
    if (typeof target !== "function") return;
    target.call(logger, "[mirafold updater]", ...values.map(sanitizeUpdateDiagnostic));
  };
  return {
    debug: (...values) => write("debug", values),
    info: (...values) => write("info", values),
    warn: (...values) => write("warn", values),
    error: (...values) => write("error", values),
  };
}

function versionDetail(desktopVersion, shellVersion) {
  return [`Mirafold Desktop ${desktopVersion}`, `Mirafold Shell ${shellVersion}`].join("\n");
}

/**
 * Create the one updater controller used by the main process.
 *
 * The updater package itself is loaded lazily through `loadUpdater`. That is a
 * meaningful boundary: a development run or Microsoft Store build never even
 * constructs electron-updater's singleton, reads an update configuration, or
 * opens its network session.
 *
 * @param {{
 *   isPackaged: boolean,
 *   isWindowsStore: boolean,
 *   desktopVersion: string,
 *   shellVersion: string,
 *   updateStrategy?: "disabled"|"store"|"install"|"manual-download",
 *   loadUpdater: () => Promise<object>|object,
 *   showMessage: (options: object) => Promise<{response: number}>,
 *   openDownloadPage?: (url: string) => Promise<void>|void,
 *   prepareInstall: () => Promise<boolean>|boolean,
 *   recoverInstall: () => Promise<void>|void,
 *   logger?: object,
 * }} options
 */
export function createDesktopUpdater(options) {
  const {
    isPackaged,
    isWindowsStore,
    desktopVersion,
    shellVersion,
    updateStrategy = isWindowsStore
      ? "store"
      : shouldUseDesktopUpdater({ isPackaged, isWindowsStore })
        ? "install"
        : "disabled",
    loadUpdater,
    showMessage,
    openDownloadPage,
    prepareInstall,
    recoverInstall,
    logger = console,
  } = options;

  if (!["disabled", "store", "install", "manual-download"].includes(updateStrategy)) {
    throw new TypeError(`unknown desktop update strategy ${updateStrategy}`);
  }
  if (updateStrategy === "manual-download" && typeof openDownloadPage !== "function") {
    throw new TypeError("manual-download updates require an openDownloadPage function");
  }

  const enabled = updateStrategy === "install" || updateStrategy === "manual-download";
  const installsInApp = updateStrategy === "install";
  const versions = versionDetail(desktopVersion, shellVersion);
  const safeLogger = createSafeLogger(logger);

  let updater = null;
  let updaterPromise = null;
  let checkPromise = null;
  let activeCheck = null;
  let started = false;
  let installing = false;
  let installFailurePromise = null;
  let dialogTail = Promise.resolve();
  let downloadedInfo = null;
  let downloadPromptPromise = null;
  let lastPromptedVersion = null;
  let externalDownloadInfo = null;
  let externalPromptPromise = null;
  let lastExternalPromptedVersion = null;

  function queueMessage(message) {
    const result = dialogTail.then(() => showMessage(message));
    // A native-dialog failure must not create an unhandled rejection or stop
    // future dialogs. It is diagnostic only; the application remains usable.
    dialogTail = result.catch((error) => {
      safeLogger.error("Could not display updater message:", error);
    });
    return result.catch(() => ({ response: -1 }));
  }

  function manualOutcome(kind, info = {}) {
    const context = activeCheck;
    if (!context?.manual || context.outcomeReported) return;
    context.outcomeReported = true;

    if (kind === "available") {
      context.dialogPromise = queueMessage({
        type: "info",
        title: "Mirafold update",
        message: `Mirafold Desktop ${info.version} is downloading.`,
        detail: `You can keep working while the update downloads. Mirafold will ask before restarting.\n\nCurrent versions:\n${versions}`,
        buttons: ["OK"],
        defaultId: 0,
      });
    } else {
      context.dialogPromise = queueMessage({
        type: "info",
        title: "Mirafold is up to date",
        message: "You already have the latest Mirafold Desktop release.",
        detail: versions,
        buttons: ["OK"],
        defaultId: 0,
      });
    }
  }

  async function reportFailure(action, error, userVisible) {
    const diagnostic = sanitizeUpdateDiagnostic(error);
    safeLogger.warn(`${action} failed:`, diagnostic);
    if (!userVisible) return;
    await queueMessage({
      type: "warning",
      title: "Mirafold update failed",
      message: `Mirafold could not ${action}. You can keep using this version.`,
      detail: diagnostic,
      buttons: ["OK"],
      defaultId: 0,
    });
  }

  async function recoverFromInstallFailure(error) {
    if (!installing) return;
    if (installFailurePromise) return installFailurePromise;
    installFailurePromise = (async () => {
      installing = false;
      try {
        await recoverInstall();
      } catch (recoveryError) {
        safeLogger.error("Could not restart the daemon after an updater failure:", recoveryError);
      }
      await reportFailure("install the downloaded update", error, true);
    })().finally(() => {
      installFailurePromise = null;
    });
    return installFailurePromise;
  }

  async function promptForExternalDownload(info = {}, repeat = false) {
    externalDownloadInfo = info;
    const version = typeof info.version === "string" ? info.version : "the new version";
    if (externalPromptPromise) return externalPromptPromise;
    if (!repeat && lastExternalPromptedVersion === version) return;
    lastExternalPromptedVersion = version;

    externalPromptPromise = (async () => {
      const { response } = await queueMessage({
        type: "info",
        title: "Mirafold update available",
        message: `Mirafold Desktop ${version} is available to download.`,
        detail: [
          "This copy of Mirafold was extracted from the Linux .tar.gz archive, so it cannot safely replace its own files while they are running.",
          "",
          "Open the official GitHub Releases page, download the new .tar.gz, close Mirafold, and extract it in place of this copy.",
          "",
          `Current versions:\n${versions}`,
        ].join("\n"),
        buttons: ["Open download page", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        try {
          await openDownloadPage(DOWNLOAD_PAGE_URL);
        } catch (error) {
          await reportFailure("open the Mirafold download page", error, true);
        }
      }
    })().finally(() => {
      externalPromptPromise = null;
    });
    return externalPromptPromise;
  }

  function externalUpdateAvailable(info) {
    if (activeCheck) activeCheck.outcomeReported = true;
    const prompt = promptForExternalDownload(info);
    if (activeCheck && !activeCheck.dialogPromise) activeCheck.dialogPromise = prompt;
    void prompt;
  }

  async function installDownloadedUpdate() {
    if (installing || updater === null) return false;
    installing = true;

    let clean = false;
    try {
      clean = (await prepareInstall()) === true;
    } catch (error) {
      installing = false;
      await reportFailure("stop Mirafold safely before installing", error, true);
      return false;
    }

    if (!clean) {
      installing = false;
      await queueMessage({
        type: "warning",
        title: "Update not started",
        message: "Mirafold could not confirm that its local processes stopped safely.",
        detail: "The installer was not started. Mirafold has kept the downloaded update for another attempt.",
        buttons: ["OK"],
        defaultId: 0,
      });
      return false;
    }

    try {
      // Non-silent installation keeps the operating system's installer UI
      // visible. autoRunAppAfterInstall remains true, so the new version opens
      // after a successful NSIS/AppImage update.
      updater.quitAndInstall(false, true);
      // Some platform failures emit `error` synchronously instead of throwing.
      // The listener has already moved `installing` to false in that case.
      if (!installing) {
        if (installFailurePromise) await installFailurePromise;
        return false;
      }
      return true;
    } catch (error) {
      await recoverFromInstallFailure(error);
      return false;
    }
  }

  async function promptForDownloadedUpdate(info = {}, repeat = false) {
    downloadedInfo = info;
    const version = typeof info.version === "string" ? info.version : "the new version";
    if (downloadPromptPromise) return downloadPromptPromise;
    if (!repeat && lastPromptedVersion === version) return;
    lastPromptedVersion = version;

    downloadPromptPromise = (async () => {
      const { response } = await queueMessage({
        type: "info",
        title: "Mirafold update ready",
        message: `Mirafold Desktop ${version} is ready to install.`,
        detail: [
          "Installation starts only after Mirafold confirms that its local daemon and agent processes have stopped.",
          "",
          `Current versions:\n${versions}`,
        ].join("\n"),
        buttons: ["Install and restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) await installDownloadedUpdate();
    })().finally(() => {
      downloadPromptPromise = null;
    });
    return downloadPromptPromise;
  }

  async function ensureUpdater() {
    if (!enabled) return null;
    if (updaterPromise) return updaterPromise;

    updaterPromise = Promise.resolve()
      .then(loadUpdater)
      .then((candidate) => {
        if (
          candidate === null ||
          typeof candidate !== "object" ||
          typeof candidate.on !== "function" ||
          typeof candidate.checkForUpdates !== "function" ||
          (installsInApp && typeof candidate.quitAndInstall !== "function")
        ) {
          throw new TypeError("electron-updater did not provide a usable autoUpdater");
        }

        updater = candidate;
        updater.autoDownload = installsInApp;
        // Installing on an ordinary app quit would race the synchronous
        // before-quit hook. Mirafold installs only through the explicit path
        // above, after prepareInstall has proved the daemon tree is gone.
        updater.autoInstallOnAppQuit = false;
        updater.autoRunAppAfterInstall = installsInApp;
        updater.allowDowngrade = false;
        // This app publishes a complete NSIS installer. Web installers can
        // fetch a second payload that does not receive the same signature
        // verification, so reject them explicitly.
        updater.disableWebInstaller = true;
        updater.logger = safeLogger;

        updater.on("update-available", (info) => {
          if (installsInApp) manualOutcome("available", info);
          else externalUpdateAvailable(info);
        });
        updater.on("update-not-available", (info) => manualOutcome("not-available", info));
        updater.on("update-downloaded", (info) => {
          void promptForDownloadedUpdate(info);
        });
        updater.on("error", (error) => {
          if (installing) void recoverFromInstallFailure(error);
        });
        return updater;
      })
      .catch((error) => {
        updaterPromise = null;
        throw error;
      });
    return updaterPromise;
  }

  async function checkForUpdates(manual) {
    if (!enabled) return null;
    // "Later" means later in this same run too: a manual menu check should
    // reopen the install choice immediately, without redownloading or querying
    // the feed for a file already verified in electron-updater's cache.
    if (manual && downloadedInfo) {
      await promptForDownloadedUpdate(downloadedInfo, true);
      return { isUpdateAvailable: true, updateInfo: downloadedInfo, downloadPromise: null };
    }
    if (manual && externalDownloadInfo) {
      await promptForExternalDownload(externalDownloadInfo, true);
      return { isUpdateAvailable: true, updateInfo: externalDownloadInfo, downloadPromise: null };
    }
    if (checkPromise) {
      if (manual) {
        await queueMessage({
          type: "info",
          title: "Checking for updates",
          message: "Mirafold is already checking for an update.",
          buttons: ["OK"],
          defaultId: 0,
        });
      }
      return checkPromise;
    }

    const context = { manual, outcomeReported: false, dialogPromise: null };
    activeCheck = context;
    checkPromise = (async () => {
      try {
        const instance = await ensureUpdater();
        const result = await instance.checkForUpdates();

        // electron-updater emits the outcome before resolving. Keep a fallback
        // for injected implementations and future library changes.
        if (!context.outcomeReported && result !== null) {
          if (result.isUpdateAvailable && !installsInApp) {
            externalUpdateAvailable(result.updateInfo);
          } else if (manual) {
            manualOutcome(result.isUpdateAvailable ? "available" : "not-available", result.updateInfo);
          }
        }

        if (result?.downloadPromise) {
          void result.downloadPromise.catch((error) => {
            void reportFailure("download the update", error, manual);
          });
        }
        if (context.dialogPromise) await context.dialogPromise;
        return result;
      } catch (error) {
        await reportFailure("check for updates", error, manual);
        return null;
      } finally {
        if (activeCheck === context) activeCheck = null;
        checkPromise = null;
      }
    })();
    return checkPromise;
  }

  function helpMenuItems() {
    const updateItem = enabled
      ? {
          label: "Check for Updates…",
          click: () => void checkForUpdates(true),
        }
      : {
          label: isWindowsStore
            ? "Updates managed by Microsoft Store"
            : "Updates available in the installed app",
          enabled: false,
        };

    return [
      updateItem,
      { type: "separator" },
      { label: `Mirafold Desktop ${desktopVersion}`, enabled: false },
      { label: `Mirafold Shell ${shellVersion}`, enabled: false },
    ];
  }

  return {
    enabled,
    updateStrategy,
    helpMenuItems,
    checkManually: () => checkForUpdates(true),
    start() {
      if (started) return Promise.resolve(null);
      started = true;
      return checkForUpdates(false);
    },
  };
}
