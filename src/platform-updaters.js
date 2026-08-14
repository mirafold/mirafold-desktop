import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

function downloadedInstall(updater) {
  const installerPath = updater.installerPath;
  const downloadedFileInfo = updater.downloadedUpdateHelper?.downloadedFileInfo;
  if (typeof installerPath === "string" && installerPath.length > 0 && downloadedFileInfo != null) {
    return { installerPath, downloadedFileInfo };
  }
  updater.dispatchError(new Error("No update filepath provided, can't quit and install"));
  return null;
}

function fsyncFile(file) {
  const descriptor = openSync(file, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeStagingDirectory(directory, logger) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    logger?.warn?.(`Could not remove the AppImage update staging directory: ${error.message}`);
  }
}

function appImageDestination(currentFile, installerPath) {
  if (!path.isAbsolute(currentFile) || currentFile.includes("\0")) {
    throw new Error(`APPIMAGE env is not a valid absolute path: "${currentFile}"`);
  }
  if (!path.isAbsolute(installerPath) || installerPath.includes("\0")) {
    throw new Error("The downloaded AppImage path is not a valid absolute path");
  }
  const currentName = path.basename(currentFile);
  return path.basename(installerPath) === currentName || !/\d+\.\d+\.\d+/.test(currentName)
    ? currentFile
    : path.join(path.dirname(currentFile), path.basename(installerPath));
}

/**
 * Copy the verified download beside its destination, preserve the prior file
 * for rollback, and atomically rename only after every fallible copy succeeds.
 */
function prepareAppImageReplacement(currentFile, installerPath, logger) {
  const destination = appImageDestination(currentFile, installerPath);
  const stagingDirectory = mkdtempSync(path.join(path.dirname(destination), ".mirafold-update-"));
  const stagedFile = path.join(stagingDirectory, "replacement.AppImage");
  const backupFile = path.join(stagingDirectory, "previous.AppImage");
  const destinationExisted = existsSync(destination);

  try {
    copyFileSync(installerPath, stagedFile, constants.COPYFILE_EXCL);
    chmodSync(stagedFile, 0o755);
    fsyncFile(stagedFile);
    if (destinationExisted) {
      copyFileSync(destination, backupFile, constants.COPYFILE_EXCL);
      fsyncFile(backupFile);
    }
    renameSync(stagedFile, destination);
  } catch (error) {
    removeStagingDirectory(stagingDirectory, logger);
    throw error;
  }

  let finished = false;
  return {
    destination,
    commit() {
      if (finished) return;
      finished = true;
      // A versioned AppImage gets a new filename. Keep the currently installed
      // file until the replacement has actually launched, then remove it as a
      // best-effort cleanup; failure leaves two working versions, not zero.
      if (destination !== currentFile) {
        try {
          unlinkSync(currentFile);
        } catch (error) {
          logger?.warn?.(`Could not remove the previous AppImage: ${error.message}`);
        }
      }
      removeStagingDirectory(stagingDirectory, logger);
    },
    rollback() {
      if (finished) return null;
      finished = true;
      let rollbackError = null;
      try {
        if (destinationExisted) renameSync(backupFile, destination);
        else unlinkSync(destination);
      } catch (error) {
        rollbackError = error;
      }
      if (rollbackError === null) {
        removeStagingDirectory(stagingDirectory, logger);
      } else {
        logger?.error?.("Could not restore the prior AppImage; its backup was retained");
      }
      return rollbackError;
    },
  };
}

function installFailure(updater, error, rollbackError = null) {
  updater.quitAndInstallCalled = false;
  const reported = rollbackError
    ? new AggregateError([error, rollbackError], "Installer launch failed and rollback failed")
    : error;
  updater.dispatchError(reported);
  return false;
}

/**
 * Retain electron-updater's AppImage download/checksum implementation while
 * replacing its unlink-before-copy install step with an atomic transaction.
 */
export function createSafeAppImageUpdater(AppImageUpdater, { emitBeforeQuit = () => {} } = {}) {
  return class MirafoldAppImageUpdater extends AppImageUpdater {
    quitAndInstall(isSilent = false, isForceRunAfter = false) {
      if (this.quitAndInstallCalled) {
        this._logger.warn("install call ignored: quitAndInstallCalled is set to true");
        return Promise.resolve(false);
      }
      const download = downloadedInstall(this);
      if (!download) return Promise.resolve(false);
      this.quitAndInstallCalled = true;
      const forceRunAfter = isSilent ? isForceRunAfter : this.autoRunAppAfterInstall;
      return this.#replaceLaunchAndQuit(download.installerPath, forceRunAfter);
    }

    async #replaceLaunchAndQuit(installerPath, forceRunAfter) {
      const currentFile = process.env.APPIMAGE;
      if (currentFile == null) {
        return installFailure(this, new Error("APPIMAGE env is not defined"));
      }

      let replacement;
      try {
        replacement = prepareAppImageReplacement(currentFile, installerPath, this._logger);
        const env = { ...process.env, APPIMAGE_SILENT_INSTALL: "true" };
        if (forceRunAfter) {
          await this.spawnLog(replacement.destination, [], env);
        } else {
          env.APPIMAGE_EXIT_AFTER_INSTALL = "true";
          execFileSync(replacement.destination, [], { env });
        }
      } catch (error) {
        return installFailure(this, error, replacement?.rollback());
      }

      replacement.commit();
      try {
        await this.downloadedUpdateHelper?.clear?.();
      } catch (error) {
        this._logger.warn(`Could not clear the installed AppImage from the update cache: ${error.message}`);
      }
      if (replacement.destination !== currentFile) {
        this.emit("appimage-filename-updated", replacement.destination);
      }
      emitBeforeQuit();
      this.app.quit();
      return true;
    }
  };
}

/**
 * Retain electron-updater's NSIS download and signature verification while
 * awaiting the operating system's installer-launch acknowledgment before quit.
 */
export function createSafeNsisUpdater(
  NsisUpdater,
  {
    emitBeforeQuit = () => {},
    openPath = null,
    resourcesPath = () => process.resourcesPath,
  } = {},
) {
  return class MirafoldNsisUpdater extends NsisUpdater {
    quitAndInstall(isSilent = false, isForceRunAfter = false) {
      if (this.quitAndInstallCalled) {
        this._logger.warn("install call ignored: quitAndInstallCalled is set to true");
        return Promise.resolve(false);
      }
      const download = downloadedInstall(this);
      if (!download) return Promise.resolve(false);
      this.quitAndInstallCalled = true;
      const forceRunAfter = isSilent ? isForceRunAfter : this.autoRunAppAfterInstall;
      return this.#launchAndQuit(
        download.installerPath,
        download.downloadedFileInfo,
        isSilent,
        forceRunAfter,
      );
    }

    async #launchAndQuit(installerPath, downloadedFileInfo, isSilent, forceRunAfter) {
      const args = ["--updated"];
      if (isSilent) args.push("/S");
      if (forceRunAfter) args.push("--force-run");
      if (this.installDirectory) args.push(`/D=${this.installDirectory}`);
      const packagePath = this.downloadedUpdateHelper?.packageFile;
      if (packagePath != null) args.push(`--package-file=${packagePath}`);

      const launchElevated = () =>
        this.spawnLog(path.join(resourcesPath(), "elevate.exe"), [installerPath, ...args]);

      try {
        if (downloadedFileInfo.isAdminRightsRequired) {
          this._logger.info("isAdminRightsRequired is set to true, run installer using elevate.exe");
          await launchElevated();
        } else {
          try {
            await this.spawnLog(installerPath, args);
          } catch (error) {
            const errorCode = error?.code;
            this._logger.info(
              `Cannot run installer: error code: ${errorCode}, error message: "${error.message}"`,
            );
            if (errorCode === "UNKNOWN" || errorCode === "EACCES") {
              await launchElevated();
            } else if (errorCode === "ENOENT" && typeof openPath === "function") {
              const openError = await openPath(installerPath);
              if (openError) throw Object.assign(new Error(openError), { code: "ENOENT" });
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        return installFailure(this, error);
      }

      emitBeforeQuit();
      this.app.quit();
      return true;
    }
  };
}
