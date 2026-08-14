import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  silentInstallArguments,
  silentUninstallArguments,
  verifyWindowsInstaller,
  waitForPathRemoval,
  windowsInstallerPaths,
} from "../scripts/windows-installer-smoke.mjs";

function ok(stdout = "") {
  return { error: null, signal: null, status: 0, stdout, stderr: "" };
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-nsis-smoke-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "dist");
  const temporaryDirectory = path.join(root, "temp");
  mkdirSync(output);
  mkdirSync(temporaryDirectory);
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    version: "1.2.3",
    dependencies: { mirafold: "0.3.7" },
  })}\n`);
  writeFileSync(path.join(output, "Mirafold-Setup-1.2.3.exe"), "fixture installer");
  return { root, output, temporaryDirectory };
}

function simulatedWindows({ verifyFailure = null, userRegistrationView = "both" } = {}) {
  let installDirectory = null;
  let registered = false;
  let installs = 0;
  let uninstalls = 0;

  const spawn = (command, args) => {
    if (path.basename(command) === "Mirafold-Setup-1.2.3.exe") {
      installs += 1;
      assert.deepEqual(args.slice(0, -1), ["/S", "/currentuser", "/no-desktop-shortcut"]);
      assert.match(args.at(-1), /^\/D=/);
      installDirectory = args.at(-1).slice(3);
      const app = path.join(installDirectory, "resources", "app");
      mkdirSync(app, { recursive: true });
      writeFileSync(path.join(installDirectory, "Mirafold.exe"), "installed executable");
      writeFileSync(path.join(installDirectory, "Uninstall Mirafold.exe"), "installed uninstaller");
      registered = true;
      return ok();
    }
    if (path.basename(command) === "Uninstall Mirafold.exe") {
      uninstalls += 1;
      assert.deepEqual(args, ["/S", "/currentuser"]);
      registered = false;
      rmSync(installDirectory, { recursive: true, force: true });
      return ok();
    }
    if (command === "reg.exe") {
      const hive = args[1].split("\\")[0];
      const view = args.find((argument) => argument.startsWith("/reg:"))?.slice(5);
      assert.deepEqual(args.slice(2), ["/s", `/reg:${view}`]);
      if (
        hive === "HKCU"
        && registered
        && (userRegistrationView === "both" || userRegistrationView === view)
      ) {
        return ok(`InstallLocation    REG_SZ    ${installDirectory}\r\n`);
      }
      return ok(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\r\n`);
    }
    throw new Error(`unexpected simulated command ${command}`);
  };

  const verifyInstalledApplication = (options) => {
    assert.equal(options.platform, "windows");
    assert.equal(options.expectedDesktopVersion, "1.2.3");
    assert.equal(options.expectedShellVersion, "0.3.7");
    assert.equal(options.executable, path.join(installDirectory, "Mirafold.exe"));
    assert.equal(options.appDirectory, path.join(installDirectory, "resources", "app"));
    if (verifyFailure) throw verifyFailure;
    return {
      desktopVersion: "1.2.3",
      shellVersion: "0.3.7",
      nodePtyLoaded: true,
      watcherLoaded: true,
      daemonLifecycle: {
        processTreeStopped: true,
        unreachableAfterStop: true,
        executableProcessesAfterProbe: 0,
      },
    };
  };

  return {
    spawn,
    verifyInstalledApplication,
    counts: () => ({ installs, uninstalls }),
  };
}

test("silent NSIS arguments force current-user mode and keep /D last", () => {
  const installDirectory = path.resolve("fixture-install");
  assert.deepEqual(silentInstallArguments(installDirectory), [
    "/S",
    "/currentuser",
    "/no-desktop-shortcut",
    `/D=${installDirectory}`,
  ]);
  assert.deepEqual(silentUninstallArguments(), ["/S", "/currentuser"]);
  assert.throws(() => silentInstallArguments("relative"), /must be absolute/);
  assert.throws(() => silentInstallArguments(`${installDirectory}\nnext`), /forbidden/);
});

test("Windows installer paths name the built and installed NSIS files exactly", () => {
  const output = path.resolve("fixture-dist");
  const installed = path.resolve("fixture-installed");
  assert.deepEqual(windowsInstallerPaths(output, "1.2.3", installed), {
    installer: path.join(output, "Mirafold-Setup-1.2.3.exe"),
    executable: path.join(installed, "Mirafold.exe"),
    appDirectory: path.join(installed, "resources", "app"),
    uninstaller: path.join(installed, "Uninstall Mirafold.exe"),
  });
});

test("the NSIS probe proves per-user registration, installed runtime, and complete uninstall", (t) => {
  const f = fixture(t);
  const simulated = simulatedWindows({ userRegistrationView: "32" });
  const report = verifyWindowsInstaller(f.output, {
    root: f.root,
    platform: "windows",
    temporaryDirectory: f.temporaryDirectory,
    spawn: simulated.spawn,
    verifyInstalledApplication: simulated.verifyInstalledApplication,
  });
  assert.deepEqual(simulated.counts(), { installs: 1, uninstalls: 1 });
  assert.equal(report.installationMode, "current-user");
  assert.equal(report.installCompleted, true);
  assert.equal(report.userRegistration, true);
  assert.equal(report.machineRegistration, false);
  assert.equal(report.installedApplication.daemonLifecycle.processTreeStopped, true);
  assert.equal(report.uninstallCompleted, true);
  assert.equal(report.installDirectoryRemoved, true);
  assert.equal(report.registrationRemoved, true);
});

test("NSIS self-deletion polling waits for the installation path to disappear", () => {
  const target = path.resolve("fixture-installed");
  let checks = 0;
  let clock = 0;
  const pauses = [];
  assert.equal(waitForPathRemoval(target, {
    timeoutMs: 250,
    exists: () => {
      checks += 1;
      return checks < 3;
    },
    now: () => clock,
    pause: (milliseconds) => {
      pauses.push(milliseconds);
      clock += milliseconds;
    },
  }), true);
  assert.deepEqual(pauses, [100, 100]);

  assert.equal(waitForPathRemoval(target, {
    timeoutMs: 100,
    exists: () => true,
    now: () => clock,
    pause: (milliseconds) => { clock += milliseconds; },
  }), false);
});

test("a rejected installed runtime still receives a silent cleanup uninstall", (t) => {
  const f = fixture(t);
  const simulated = simulatedWindows({ verifyFailure: new Error("installed bytes rejected") });
  assert.throws(
    () => verifyWindowsInstaller(f.output, {
      root: f.root,
      platform: "win32",
      temporaryDirectory: f.temporaryDirectory,
      spawn: simulated.spawn,
      verifyInstalledApplication: simulated.verifyInstalledApplication,
    }),
    /installed bytes rejected/,
  );
  assert.deepEqual(simulated.counts(), { installs: 1, uninstalls: 1 });
});

test("the NSIS lifecycle probe refuses non-Windows execution", (t) => {
  const f = fixture(t);
  assert.throws(
    () => verifyWindowsInstaller(f.output, {
      root: f.root,
      platform: "linux",
      temporaryDirectory: f.temporaryDirectory,
    }),
    /requires Windows/,
  );
});
