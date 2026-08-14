#!/usr/bin/env node

// Native-runner packaged smoke check. The built Electron executable runs as its
// bundled Node runtime and loads the exact app tree electron-builder produced.
// This catches the high-value "build succeeded, packaged native module cannot
// load" class without opening a GUI or reaching any model/relay service.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MARKER = "MIRAFOLD_PACKAGED_SMOKE=";
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

function minimalEnvironment(appDirectory) {
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
    "LD_LIBRARY_PATH",
    "LANG",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
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

export function runPackagedNodeProbe({
  executable,
  appDirectory,
  expectedDesktopVersion,
  expectedShellVersion,
  spawn = spawnSync,
} = {}) {
  invariant(typeof executable === "string" && path.isAbsolute(executable), "packaged executable path must be absolute");
  invariant(lstatSync(executable).isFile(), "packaged executable must be a regular file");
  invariant(typeof appDirectory === "string" && path.isAbsolute(appDirectory), "packaged app path must be absolute");
  invariant(lstatSync(appDirectory).isDirectory(), "packaged app path must be a directory");
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
  if (result.error) throw new Error(`packaged executable could not run: ${result.error.message}`);
  invariant(result.signal === null, `packaged executable ended from signal ${result.signal}`);
  invariant(result.status === 0, `packaged executable exited ${result.status}: ${String(result.stderr).slice(-4000)}`);
  invariant(String(result.stderr).trim() === "", `packaged executable wrote stderr: ${String(result.stderr).slice(-4000)}`);
  const lines = String(result.stdout).trim().split(/\r?\n/).filter(Boolean);
  invariant(lines.length === 1 && lines[0].startsWith(MARKER), "packaged executable returned unexpected output");
  let report;
  try {
    report = JSON.parse(lines[0].slice(MARKER.length));
  } catch (error) {
    throw new Error(`packaged executable report is invalid JSON: ${error.message}`);
  }
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

export function packagedPaths(platform, outputDirectory) {
  invariant(platform === "linux" || platform === "windows", `unsupported smoke platform ${platform}`);
  const unpacked = path.join(outputDirectory, platform === "linux" ? "linux-unpacked" : "win-unpacked");
  return {
    executable: path.join(unpacked, platform === "linux" ? "mirafold" : "Mirafold.exe"),
    appDirectory: path.join(unpacked, "resources", "app"),
  };
}

export function verifyPackagedApplication(platform, outputDirectory, { root = ROOT, spawn = spawnSync } = {}) {
  const packageMetadata = readJson(path.join(root, "package.json"), "source package.json");
  const expectedDesktopVersion = stableVersion(packageMetadata.version, "source Desktop version");
  const expectedShellVersion = stableVersion(packageMetadata?.dependencies?.mirafold, "source Shell version");
  const paths = packagedPaths(platform, path.resolve(outputDirectory));
  return runPackagedNodeProbe({
    ...paths,
    expectedDesktopVersion,
    expectedShellVersion,
    spawn,
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
