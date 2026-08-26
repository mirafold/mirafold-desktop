#!/usr/bin/env node

// Windows-runner proof for the actual assisted NSIS candidate. It performs an
// explicitly current-user, silent install into one fresh runner-temp directory,
// verifies the HKCU (and absence of HKLM) registration, runs the same packaged
// native/daemon smoke against the installed bytes, then silently uninstalls and
// proves both the files and registration are gone. No GUI behavior is inferred
// from this; SmartScreen, the visible wizard, and folder selection remain human
// checks because an Actions process cannot truthfully observe them.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackagedPaths } from "./packaged-smoke.mjs";
import { invariant, readJson, stableVersion } from "./shared.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UNINSTALL_ROOT = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
function windowsEnvironment() {
  const env = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function checkedCommand(executable, args, label, spawn) {
  const result = spawn(executable, args, {
    encoding: "utf8",
    env: windowsEnvironment(),
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 6 * 60_000,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  invariant(result.signal === null, `${label} ended from signal ${result.signal}`);
  invariant(
    result.status === 0,
    `${label} exited ${result.status}: ${String(result.stderr || result.stdout).slice(-4000)}`,
  );
  return result;
}

function validateNsisDirectory(installDirectory, operation) {
  invariant(typeof installDirectory === "string" && path.isAbsolute(installDirectory), `${operation} path must be absolute`);
  invariant(!/[\0\r\n"]/u.test(installDirectory), `${operation} path contains forbidden command-line characters`);
}

export function silentInstallArguments(installDirectory) {
  validateNsisDirectory(installDirectory, "NSIS install");
  // electron-builder's assisted installer parses /D itself; it must remain the
  // final argument. /currentuser selects the non-elevated HKCU path explicitly.
  return ["/S", "/currentuser", "/no-desktop-shortcut", `/D=${installDirectory}`];
}

export function silentUninstallArguments(installDirectory) {
  validateNsisDirectory(installDirectory, "NSIS uninstall");
  // electron-builder's own waited old-version removal copies the uninstaller
  // outside $INSTDIR and keeps this NSIS _?= override last. That makes the
  // observed process perform the removal instead of returning after a
  // self-relocation handoff.
  return ["/S", "/currentuser", `_?=${installDirectory}`];
}

export function windowsInstallerPaths(outputDirectory, version, installDirectory) {
  invariant(typeof outputDirectory === "string" && path.isAbsolute(outputDirectory), "NSIS output path must be absolute");
  stableVersion(version, "Desktop version");
  invariant(typeof installDirectory === "string" && path.isAbsolute(installDirectory), "NSIS install path must be absolute");
  return {
    installer: path.join(outputDirectory, `Mirafold-Setup-${version}.exe`),
    executable: path.join(installDirectory, "Mirafold.exe"),
    appDirectory: path.join(installDirectory, "resources", "app"),
    uninstaller: path.join(installDirectory, "Uninstall Mirafold.exe"),
  };
}

function registryQueryOptions() {
  return {
    encoding: "utf8",
    env: windowsEnvironment(),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  };
}

function registrationExists(hive, view, installDirectory, spawn) {
  const result = spawn(
    "reg.exe",
    ["query", `${hive}\\${UNINSTALL_ROOT}`, "/s", `/reg:${view}`],
    registryQueryOptions(),
  );
  if (result.error) throw new Error(`Windows ${hive} registration query could not run: ${result.error.message}`);
  invariant(result.signal === null, `Windows ${hive} registration query ended from signal ${result.signal}`);
  if (result.status === 1) {
    const detail = String(result.stderr || result.stdout).trim();
    invariant(
      /unable to find the specified registry key or value/i.test(detail),
      `Windows ${hive} ${view}-bit registration query failed: ${detail || "no diagnostic"}`,
    );
    return false;
  }
  invariant(result.status === 0, `Windows ${hive} registration query exited ${result.status}`);
  return String(result.stdout).toLowerCase().includes(installDirectory.toLowerCase());
}

function registrationDiagnostics(hive, view, spawn) {
  const result = spawn(
    "reg.exe",
    ["query", `${hive}\\${UNINSTALL_ROOT}`, "/s", "/f", "Mirafold", "/d", `/reg:${view}`],
    registryQueryOptions(),
  );
  if (result.error) return `query could not run: ${result.error.message}`;
  const detail = String(result.stdout || result.stderr).trim();
  if (result.status === 1) return "no Mirafold registration";
  if (result.status !== 0) return `query exited ${result.status}: ${detail || "no diagnostic"}`;
  return detail.slice(-4000);
}

function registrationViews(hive, installDirectory, spawn) {
  return {
    registry64: registrationExists(hive, "64", installDirectory, spawn),
    registry32: registrationExists(hive, "32", installDirectory, spawn),
  };
}

function anyRegistration(views) {
  return views.registry64 || views.registry32;
}

function defaultTemporaryDirectory() {
  const runner = process.env.RUNNER_TEMP;
  if (typeof runner === "string" && path.isAbsolute(runner) && existsSync(runner) && lstatSync(runner).isDirectory()) {
    return runner;
  }
  return tmpdir();
}

const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

function blockingPause(milliseconds) {
  Atomics.wait(SLEEP_WORD, 0, 0, milliseconds);
}

export function waitForPathRemoval(
  target,
  {
    timeoutMs = 30_000,
    exists = existsSync,
    now = Date.now,
    pause = blockingPause,
  } = {},
) {
  invariant(typeof target === "string" && path.isAbsolute(target), "NSIS removal path must be absolute");
  invariant(Number.isInteger(timeoutMs) && timeoutMs >= 0, "NSIS removal timeout must be a non-negative integer");
  const deadline = now() + timeoutMs;
  while (exists(target)) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    pause(Math.min(100, remaining));
  }
  return true;
}

export function verifyWindowsInstaller(
  outputDirectory,
  {
    root = ROOT,
    spawn = spawnSync,
    platform = process.platform,
    temporaryDirectory = defaultTemporaryDirectory(),
    verifyInstalledApplication = verifyPackagedPaths,
    progress = () => {},
  } = {},
) {
  invariant(platform === "win32" || platform === "windows", "NSIS lifecycle smoke requires Windows");
  invariant(typeof temporaryDirectory === "string" && path.isAbsolute(temporaryDirectory), "NSIS temp path must be absolute");
  invariant(existsSync(temporaryDirectory) && lstatSync(temporaryDirectory).isDirectory(), "NSIS temp path must be a directory");

  const metadata = readJson(path.join(root, "package.json"), "source package.json");
  const desktopVersion = stableVersion(metadata.version, "source Desktop version");
  const shellVersion = stableVersion(metadata?.dependencies?.mirafold, "source Shell version");
  const absoluteOutput = path.resolve(outputDirectory);
  const temporaryRoot = mkdtempSync(path.join(temporaryDirectory, "mirafold-nsis-smoke-"));
  const installDirectory = path.join(temporaryRoot, "installed");
  const detachedUninstaller = path.join(temporaryRoot, "Mirafold-uninstaller-probe.exe");
  const paths = windowsInstallerPaths(absoluteOutput, desktopVersion, installDirectory);
  invariant(existsSync(paths.installer) && lstatSync(paths.installer).isFile(), "NSIS candidate is missing");

  let uninstalled = false;
  let outcome;
  let failure = null;
  try {
    checkedCommand(paths.installer, silentInstallArguments(installDirectory), "silent current-user NSIS install", spawn);
    progress("silent current-user installer exited successfully");
    invariant(existsSync(paths.executable) && lstatSync(paths.executable).isFile(), "installed Mirafold executable is missing");
    invariant(existsSync(paths.appDirectory) && lstatSync(paths.appDirectory).isDirectory(), "installed app directory is missing");
    invariant(existsSync(paths.uninstaller) && lstatSync(paths.uninstaller).isFile(), "installed Mirafold uninstaller is missing");
    progress("installer produced the executable, app tree, and uninstaller");

    const userRegistration = registrationViews("HKCU", installDirectory, spawn);
    const machineRegistration = registrationViews("HKLM", installDirectory, spawn);
    progress(`exact registration views: ${JSON.stringify({ userRegistration, machineRegistration })}`);
    if (!anyRegistration(userRegistration)) {
      const diagnostics = {
        hkcu64: registrationDiagnostics("HKCU", "64", spawn),
        hkcu32: registrationDiagnostics("HKCU", "32", spawn),
        hklm64: registrationDiagnostics("HKLM", "64", spawn),
        hklm32: registrationDiagnostics("HKLM", "32", spawn),
      };
      throw new Error(`NSIS did not register the exact install under the current user: ${JSON.stringify(diagnostics)}`);
    }
    invariant(!anyRegistration(machineRegistration), "NSIS registered the current-user install at machine scope");

    const installedApplication = verifyInstalledApplication({
      platform: "windows",
      executable: paths.executable,
      appDirectory: paths.appDirectory,
      expectedDesktopVersion: desktopVersion,
      expectedShellVersion: shellVersion,
      spawn,
      temporaryDirectory,
    });
    progress("installed bytes passed native-module and daemon lifecycle smoke");

    copyFileSync(paths.uninstaller, detachedUninstaller);
    invariant(lstatSync(detachedUninstaller).isFile(), "detached Mirafold uninstaller is missing");
    progress("copied the uninstaller outside the installation directory");
    checkedCommand(
      detachedUninstaller,
      silentUninstallArguments(installDirectory),
      "silent current-user NSIS uninstall",
      spawn,
    );
    progress("silent current-user uninstaller exited successfully");
    invariant(waitForPathRemoval(installDirectory), "NSIS uninstall left the installation directory behind");
    progress("uninstaller removed the installation directory");
    uninstalled = true;
    const userAfter = registrationViews("HKCU", installDirectory, spawn);
    const machineAfter = registrationViews("HKLM", installDirectory, spawn);
    invariant(!anyRegistration(userAfter), "NSIS uninstall left current-user registration behind");
    invariant(!anyRegistration(machineAfter), "NSIS uninstall left machine registration behind");

    outcome = {
      installer: path.basename(paths.installer),
      installationMode: "current-user",
      installCompleted: true,
      userRegistration: true,
      machineRegistration: false,
      installedApplication,
      uninstallCompleted: true,
      installDirectoryRemoved: true,
      registrationRemoved: true,
    };
  } catch (error) {
    failure = error;
  }

  let cleanupFailure = null;
  if (!uninstalled && existsSync(paths.uninstaller)) {
    try {
      progress("attempting cleanup uninstall after a failed proof");
      if (!existsSync(detachedUninstaller)) copyFileSync(paths.uninstaller, detachedUninstaller);
      invariant(lstatSync(detachedUninstaller).isFile(), "detached cleanup uninstaller is missing");
      checkedCommand(
        detachedUninstaller,
        silentUninstallArguments(installDirectory),
        "cleanup NSIS uninstall",
        spawn,
      );
      progress("cleanup uninstall exited successfully");
      invariant(waitForPathRemoval(installDirectory), "cleanup NSIS uninstall left the installation directory behind");
      progress("cleanup uninstall removed the installation directory");
      uninstalled = true;
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = cleanupFailure ?? error;
  }

  if (failure && cleanupFailure) {
    throw new AggregateError([failure, cleanupFailure], `${failure.message}; NSIS cleanup also failed`);
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return outcome;
}

function main(args) {
  if (args.length !== 1) throw new Error("usage: windows-installer-smoke.mjs OUTPUT_DIRECTORY");
  const report = verifyWindowsInstaller(args[0], {
    progress: (message) => process.stdout.write(`NSIS smoke: ${message}\n`),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const nested = Array.isArray(error?.errors)
      ? error.errors.map((item, index) => `  ${index + 1}. ${item?.message ?? String(item)}`).join("\n")
      : "";
    process.stderr.write(`Windows installer smoke failed: ${error.message}${nested ? `\n${nested}` : ""}\n`);
    process.exitCode = 1;
  }
}
