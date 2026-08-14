#!/usr/bin/env node

// Native-runner packaged smoke check. The built Electron executable runs as its
// bundled Node runtime and loads the exact app tree electron-builder produced.
// This catches the high-value "build succeeded, packaged native module cannot
// load" class without opening a GUI or reaching any model/relay service.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MARKER = "MIRAFOLD_PACKAGED_SMOKE=";
const DAEMON_MARKER = "MIRAFOLD_PACKAGED_DAEMON_SMOKE=";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file, label) {
  invariant(lstatSync(file).isFile(), `${label} must be a regular file`);
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must contain an object`);
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function stableVersion(value, label) {
  invariant(typeof value === "string" && STABLE_VERSION.test(value), `${label} must be a stable x.y.z version`);
  return value;
}

function minimalEnvironment(appDirectory, additions = {}) {
  const env = {
    ELECTRON_RUN_AS_NODE: "1",
    MIRAFOLD_PACKAGED_APP: appDirectory,
  };
  for (const name of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "SHELL",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "LD_LIBRARY_PATH",
    "LANG",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...additions };
}

const CHILD_PROBE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const app = process.env.MIRAFOLD_PACKAGED_APP;
if (!app || !path.isAbsolute(app)) throw new Error("packaged app path is not absolute");
const requireApp = createRequire(path.join(app, "package.json"));
const desktop = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
const daemonEntry = requireApp.resolve("mirafold/dist-server/index.js");
const daemonRelative = path.relative(app, daemonEntry);
if (!daemonRelative || daemonRelative === ".." || daemonRelative.startsWith(".." + path.sep) || path.isAbsolute(daemonRelative)) {
  throw new Error("daemon entry escaped the packaged app");
}
if (!fs.statSync(daemonEntry).isFile()) throw new Error("daemon entry is not a file");
const shellRoot = path.dirname(requireApp.resolve("mirafold/package.json"));
const shell = JSON.parse(fs.readFileSync(path.join(shellRoot, "package.json"), "utf8"));
const pty = requireApp("@lydell/node-pty");
if (typeof pty.spawn !== "function") throw new Error("packaged node-pty has no spawn function");
const watcher = requireApp("@parcel/watcher");
if (typeof watcher.subscribe !== "function") throw new Error("packaged watcher has no subscribe function");
if (!fs.statSync(path.join(app, desktop.main)).isFile()) throw new Error("Desktop main entry is not a file");
process.stdout.write(${JSON.stringify(MARKER)} + JSON.stringify({
  desktopVersion: desktop.version,
  shellVersion: shell.version,
  daemonEntry: daemonRelative.split(path.sep).join("/"),
  nodePtyLoaded: true,
  watcherLoaded: true,
}) + "\n");
`;

// Runs inside the packaged Electron executable under ELECTRON_RUN_AS_NODE.
// Importing Desktop's own Daemon class is deliberate: the hosted proof must
// exercise the exact spawn, URL parsing, credential redaction, and process-tree
// shutdown code the GUI uses, not a second approximation of that lifecycle.
const DAEMON_CHILD_PROBE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const app = process.env.MIRAFOLD_PACKAGED_APP;
const project = process.env.MIRAFOLD_PROBE_PROJECT;
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function safeError(error) {
  return String(error && (error.stack || error.message) || error)
    .replace(/([?&]token=)[^\s&"'<>]+/gi, "$1<redacted>")
    .replace(/(\bpairing code\s*:\s*)[A-Za-z0-9_-]+/gi, "$1<redacted>");
}
async function request(url, timeout, headers = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  const contentType = response.headers.get("content-type") || "";
  const location = response.headers.get("location");
  const setCookie = response.headers.get("set-cookie");
  await response.arrayBuffer();
  return { status: response.status, contentType, location, setCookie };
}
function stopDaemon(daemon) {
  // The cleanup Promise must keep this otherwise-headless process alive through
  // its bounded SIGTERM/SIGKILL polling, exactly as ordinary Electron quit does.
  return daemon.stop();
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

async function verifyWindowsCrashOwnership(imported) {
  const readyFile = path.join(project, "windows-crash-child.json");
  const fakeDaemon = path.join(project, "windows-crash-daemon.cjs");
  fs.writeFileSync(fakeDaemon, [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const { createRequire } = require("node:module");',
    'const path = require("node:path");',
    'const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");',
    'const requireApp = createRequire(path.join(process.env.MIRAFOLD_PACKAGED_APP, "package.json"));',
    'const pty = requireApp("@lydell/node-pty");',
    'const terminal = pty.spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine(\\"JOB_PTY_OK\\")"],',
    '  { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });',
    'let ptyOutput = "";',
    'terminal.onData((data) => { ptyOutput += data; });',
    'terminal.onExit(({ exitCode }) => {',
    '  if (exitCode !== 0 || !ptyOutput.includes("JOB_PTY_OK")) process.exit(72);',
    '  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "while ($true) { Start-Sleep -Seconds 60 }"],',
    '    { stdio: "ignore", windowsHide: true });',
    '  child.once("error", () => process.exit(73));',
    '  child.once("spawn", () => {',
    '    writeFileSync(process.env.MIRAFOLD_JOB_CRASH_READY, JSON.stringify({',
    '      pid: child.pid,',
    '      runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
    '      conptyWorkedInsideJob: true,',
    '    }));',
    '    setTimeout(() => process.exit(23), 100);',
    '  });',
    '});',
    '',
  ].join("\n"));

  const launch = imported.daemonLaunchSpec({
    platform: "win32",
    executable: process.execPath,
    bootstrapEntry: path.join(app, "src", "daemon-bootstrap.cjs"),
    daemonEntry: fakeDaemon,
    windowsJobEntry: path.join(app, "src", "windows-daemon-job.ps1"),
    env: { ...process.env, MIRAFOLD_JOB_CRASH_READY: readyFile },
  });
  const wrapper = spawn(launch.command, launch.args, {
    cwd: project,
    env: launch.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  wrapper.stderr.setEncoding("utf8");
  wrapper.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  let outcome = null;
  const closed = new Promise((resolve) => {
    wrapper.once("error", (error) => resolve({ error }));
    wrapper.once("close", (code, signal) => resolve({ code, signal }));
  }).then((value) => {
    outcome = value;
    return value;
  });

  const readyDeadline = Date.now() + 15000;
  while (!fs.existsSync(readyFile) && outcome === null && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  invariant(fs.existsSync(readyFile), "Windows crash child did not start: " + stderr);
  const report = JSON.parse(fs.readFileSync(readyFile, "utf8"));
  invariant(Number.isInteger(report.pid) && report.pid > 0, "Windows crash child reported no PID");
  invariant(report.runAsNode === null, "Windows crash child inherited Electron Node mode");
  invariant(report.conptyWorkedInsideJob === true, "Windows ConPTY failed inside the Job Object");

  const wrapperResult = await closed;
  invariant(!wrapperResult.error, "Windows Job Object wrapper failed: " + wrapperResult.error?.message);
  invariant(wrapperResult.signal === null, "Windows Job Object wrapper ended from " + wrapperResult.signal);
  invariant(wrapperResult.code === 23, "Windows Job Object wrapper exited " + wrapperResult.code + ": " + stderr);

  const stoppedDeadline = Date.now() + 10000;
  while (processExists(report.pid) && Date.now() < stoppedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stopped = !processExists(report.pid);
  if (!stopped) {
    spawnSync("taskkill.exe", ["/PID", String(report.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
  invariant(stopped, "Windows Job Object left crash descendant " + report.pid + " running");
  return true;
}

(async () => {
  invariant(app && path.isAbsolute(app), "packaged app path is not absolute");
  invariant(project && path.isAbsolute(project), "probe project path is not absolute");
  invariant(fs.statSync(project).isDirectory(), "probe project is not a directory");
  const daemonModule = path.join(app, "src", "daemon.js");
  invariant(fs.statSync(daemonModule).isFile(), "packaged Desktop daemon module is missing");
  const imported = await import(pathToFileURL(daemonModule).href);
  invariant(typeof imported.Daemon === "function", "packaged Desktop daemon class is missing");

  let crash = null;
  const daemon = new imported.Daemon((info) => { crash = info; });
  const guard = setTimeout(() => {
    void stopDaemon(daemon).finally(() => process.exit(70));
  }, 75000);

  try {
    const rawUrl = await daemon.start(project);
    const parsed = new URL(rawUrl);
    const queryKeys = [...parsed.searchParams.keys()];
    const token = parsed.searchParams.get("token");
    invariant(parsed.protocol === "http:", "daemon startup URL is not HTTP");
    invariant(parsed.hostname === "127.0.0.1", "daemon startup URL is not IPv4 loopback");
    invariant(/^\d+$/.test(parsed.port) && Number(parsed.port) > 0 && Number(parsed.port) <= 65535,
      "daemon startup URL has an invalid port");
    invariant(parsed.pathname === "/", "daemon startup URL path differs");
    invariant(parsed.username === "" && parsed.password === "" && parsed.hash === "",
      "daemon startup URL contains forbidden authority or fragment data");
    invariant(queryKeys.length === 1 && queryKeys[0] === "token" && typeof token === "string" && token.length > 0,
      "daemon startup URL does not carry exactly one non-empty token");

    const authentication = await request(rawUrl, 10000);
    invariant(authentication.status === 302, "daemon token handshake did not redirect");
    invariant(authentication.location === "/", "daemon token handshake redirected outside the root");
    invariant(typeof authentication.setCookie === "string", "daemon token handshake set no cookie");
    const cookieParts = authentication.setCookie.split(";").map((part) => part.trim());
    const cookiePair = cookieParts[0];
    const cookieSeparator = cookiePair.indexOf("=");
    invariant(cookieSeparator > 0 && cookiePair.slice(cookieSeparator + 1) === token,
      "daemon token cookie does not carry the startup token");
    const cookieAttributes = cookieParts.slice(1).map((part) => part.toLowerCase());
    invariant(cookieAttributes.includes("httponly"), "daemon token cookie is not HttpOnly");
    invariant(cookieAttributes.includes("samesite=strict"), "daemon token cookie is not SameSite=Strict");
    invariant(cookieAttributes.includes("path=/"), "daemon token cookie is not root-scoped");

    const response = await request(parsed.origin + authentication.location, 10000, { cookie: cookiePair });
    invariant(response.status === 200, "cookie-authenticated daemon root request did not succeed");
    invariant(response.contentType.toLowerCase().includes("text/html"), "cookie-authenticated daemon root is not HTML");
    invariant(crash === null, "daemon reported a crash after startup");

    const clean = await stopDaemon(daemon);
    invariant(clean === true, "Desktop could not prove complete daemon process-tree shutdown");
    let unreachableAfterStop = false;
    try {
      await request(rawUrl, 1500);
    } catch {
      unreachableAfterStop = true;
    }
    invariant(unreachableAfterStop, "daemon URL remained reachable after process-tree shutdown");
    invariant(crash === null, "intentional daemon shutdown was reported as a crash");
    const windowsCrashTreeStopped = process.platform === "win32"
      ? await verifyWindowsCrashOwnership(imported)
      : null;

    process.stdout.write(${JSON.stringify(DAEMON_MARKER)} + JSON.stringify({
      urlContract: {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: Number(parsed.port),
        pathname: parsed.pathname,
        queryKeys,
        tokenPresent: true,
      },
      authenticationRedirectStatus: authentication.status,
      authenticationCookieHardened: true,
      reachableStatus: response.status,
      htmlServed: true,
      processTreeStopped: true,
      unreachableAfterStop: true,
      crashReported: false,
      windowsCrashTreeStopped,
    }) + "\n");
  } finally {
    clearTimeout(guard);
    if (daemon.running) await stopDaemon(daemon);
  }
})().catch((error) => {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
});
`;

function assertCredentialSafe(text, label) {
  invariant(!/[?&]token=(?!<redacted>)[^\s&"'<>]+/i.test(text), `${label} exposed a daemon auth token`);
  invariant(
    !/\bpairing code\s*:\s*(?!<redacted>)[A-Za-z0-9_-]+/i.test(text),
    `${label} exposed a relay pairing code`,
  );
}

function parseMarkedReport(stdout, marker, label) {
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
  const reports = lines.filter((line) => line.startsWith(marker));
  invariant(reports.length === 1, `${label} returned ${reports.length} reports instead of one`);
  try {
    return JSON.parse(reports[0].slice(marker.length));
  } catch (error) {
    throw new Error(`${label} report is invalid JSON: ${error.message}`);
  }
}

function spawnResult(result, label) {
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  invariant(result.signal === null, `${label} ended from signal ${result.signal}`);
  invariant(result.status === 0, `${label} exited ${result.status}: ${String(result.stderr).slice(-4000)}`);
}

function validatePackagedPaths(executable, appDirectory) {
  invariant(typeof executable === "string" && path.isAbsolute(executable), "packaged executable path must be absolute");
  invariant(lstatSync(executable).isFile(), "packaged executable must be a regular file");
  invariant(typeof appDirectory === "string" && path.isAbsolute(appDirectory), "packaged app path must be absolute");
  invariant(lstatSync(appDirectory).isDirectory(), "packaged app path must be a directory");
}

export function runPackagedNodeProbe({
  executable,
  appDirectory,
  expectedDesktopVersion,
  expectedShellVersion,
  spawn = spawnSync,
} = {}) {
  validatePackagedPaths(executable, appDirectory);
  stableVersion(expectedDesktopVersion, "expected Desktop version");
  stableVersion(expectedShellVersion, "expected Shell version");

  const result = spawn(executable, ["--eval", CHILD_PROBE], {
    cwd: appDirectory,
    encoding: "utf8",
    env: minimalEnvironment(appDirectory),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  spawnResult(result, "packaged executable");
  invariant(String(result.stderr).trim() === "", `packaged executable wrote stderr: ${String(result.stderr).slice(-4000)}`);
  const report = parseMarkedReport(result.stdout, MARKER, "packaged executable");
  invariant(report.desktopVersion === expectedDesktopVersion, `packaged Desktop ${report.desktopVersion} != ${expectedDesktopVersion}`);
  invariant(report.shellVersion === expectedShellVersion, `packaged Shell ${report.shellVersion} != ${expectedShellVersion}`);
  invariant(
    typeof report.daemonEntry === "string" && report.daemonEntry.endsWith("/mirafold/dist-server/index.js"),
    "packaged daemon entry differs",
  );
  invariant(report.nodePtyLoaded === true, "packaged node-pty did not load");
  invariant(report.watcherLoaded === true, "packaged watcher did not load");
  return report;
}

function windowsExecutableProcessCount(executable, spawn) {
  const imageName = path.basename(executable);
  const env = minimalEnvironment(path.dirname(executable));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MIRAFOLD_PACKAGED_APP;
  const result = spawn("tasklist.exe", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  spawnResult(result, "Windows packaged-process query");
  invariant(String(result.stderr).trim() === "", `Windows packaged-process query wrote stderr: ${String(result.stderr).slice(-4000)}`);
  return String(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.match(/^"((?:[^"]|"")*)"/u)?.[1]?.replace(/""/gu, '"'))
    .filter((name) => typeof name === "string" && name.toLowerCase() === imageName.toLowerCase())
    .length;
}

export function runPackagedDaemonProbe({
  executable,
  appDirectory,
  spawn = spawnSync,
  platform = process.platform,
  temporaryDirectory = tmpdir(),
} = {}) {
  validatePackagedPaths(executable, appDirectory);
  invariant(typeof temporaryDirectory === "string" && path.isAbsolute(temporaryDirectory), "probe temp path must be absolute");
  invariant(lstatSync(temporaryDirectory).isDirectory(), "probe temp path must be a directory");

  const probeRoot = mkdtempSync(path.join(temporaryDirectory, "mirafold-packaged-daemon-"));
  const project = path.join(probeRoot, "project");
  mkdirSync(project);
  try {
    const result = spawn(executable, ["--eval", DAEMON_CHILD_PROBE], {
      cwd: project,
      encoding: "utf8",
      env: minimalEnvironment(appDirectory, {
        MIRAFOLD_PROBE_PROJECT: project,
        MIRAFOLD_LOG_FILE: "",
        MIRAFOLD_LOCAL_DISCOVERY: "off",
        MIRAFOLD_RELAY_URL: "off",
        MIRAFOLD_SESSION_DIR: path.join(probeRoot, "sessions"),
        MIRAFOLD_TRUST_FILE: "",
        MIRAFOLD_WORKSPACE_TRUST_FILE: "",
      }),
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 90_000,
      windowsHide: true,
    });
    assertCredentialSafe(String(result.stdout), "packaged daemon stdout");
    assertCredentialSafe(String(result.stderr), "packaged daemon stderr");
    spawnResult(result, "packaged daemon probe");
    invariant(String(result.stderr).trim() === "", `packaged daemon wrote stderr: ${String(result.stderr).slice(-4000)}`);
    const report = parseMarkedReport(result.stdout, DAEMON_MARKER, "packaged daemon probe");
    invariant(report?.urlContract?.protocol === "http:", "packaged daemon protocol differs");
    invariant(report?.urlContract?.hostname === "127.0.0.1", "packaged daemon host differs");
    invariant(Number.isInteger(report?.urlContract?.port) && report.urlContract.port > 0, "packaged daemon port differs");
    invariant(report?.urlContract?.pathname === "/", "packaged daemon path differs");
    invariant(
      Array.isArray(report?.urlContract?.queryKeys)
        && report.urlContract.queryKeys.length === 1
        && report.urlContract.queryKeys[0] === "token"
        && report.urlContract.tokenPresent === true,
      "packaged daemon token contract differs",
    );
    invariant(report.authenticationRedirectStatus === 302, "packaged daemon authentication redirect differs");
    invariant(report.authenticationCookieHardened === true, "packaged daemon authentication cookie differs");
    invariant(report.reachableStatus >= 200 && report.reachableStatus < 400, "packaged daemon was not reachable");
    invariant(report.htmlServed === true, "packaged daemon did not serve HTML");
    invariant(report.processTreeStopped === true, "packaged daemon process-tree stop was not proven");
    invariant(report.unreachableAfterStop === true, "packaged daemon remained reachable after stop");
    invariant(report.crashReported === false, "packaged daemon stop was reported as a crash");

    if ((platform === "win32" || platform === "windows") && path.basename(executable).toLowerCase() === "mirafold.exe") {
      invariant(report.windowsCrashTreeStopped === true, "packaged Windows crash tree was not stopped");
      const executableProcessesAfterProbe = windowsExecutableProcessCount(executable, spawn);
      invariant(executableProcessesAfterProbe === 0, `${executableProcessesAfterProbe} packaged Mirafold processes remained`);
      return { ...report, executableProcessesAfterProbe };
    }
    return report;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

export function verifyPackagedPaths({
  platform,
  executable,
  appDirectory,
  expectedDesktopVersion,
  expectedShellVersion,
  spawn = spawnSync,
  temporaryDirectory = tmpdir(),
} = {}) {
  const identity = runPackagedNodeProbe({
    executable,
    appDirectory,
    expectedDesktopVersion,
    expectedShellVersion,
    spawn,
  });
  const daemonLifecycle = runPackagedDaemonProbe({
    executable,
    appDirectory,
    spawn,
    platform,
    temporaryDirectory,
  });
  return { ...identity, daemonLifecycle };
}

export function packagedPaths(platform, outputDirectory) {
  invariant(platform === "linux" || platform === "windows", `unsupported smoke platform ${platform}`);
  const unpacked = path.join(outputDirectory, platform === "linux" ? "linux-unpacked" : "win-unpacked");
  return {
    executable: path.join(unpacked, platform === "linux" ? "mirafold" : "Mirafold.exe"),
    appDirectory: path.join(unpacked, "resources", "app"),
  };
}

export function verifyPackagedApplication(
  platform,
  outputDirectory,
  { root = ROOT, spawn = spawnSync, temporaryDirectory = tmpdir() } = {},
) {
  const packageMetadata = readJson(path.join(root, "package.json"), "source package.json");
  const expectedDesktopVersion = stableVersion(packageMetadata.version, "source Desktop version");
  const expectedShellVersion = stableVersion(packageMetadata?.dependencies?.mirafold, "source Shell version");
  const paths = packagedPaths(platform, path.resolve(outputDirectory));
  return verifyPackagedPaths({
    platform,
    ...paths,
    expectedDesktopVersion,
    expectedShellVersion,
    spawn,
    temporaryDirectory,
  });
}

function main(args) {
  if (args.length !== 2) throw new Error("usage: packaged-smoke.mjs linux|windows OUTPUT_DIRECTORY");
  const report = verifyPackagedApplication(args[0], args[1]);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`packaged smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
