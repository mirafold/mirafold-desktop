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
import { invariant, readJson, stableVersion } from "./shared.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MARKER = "MIRAFOLD_PACKAGED_SMOKE=";
const MCP_MARKER = "MIRAFOLD_PACKAGED_MCP_SMOKE=";
const DAEMON_MARKER = "MIRAFOLD_PACKAGED_DAEMON_SMOKE=";
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

// Runs the packaged Shell's compiled stdio server through the packaged
// Electron executable. The parent immediately drops Electron's Node-mode
// switch, then gives it back only to the one MCP child. This is the process
// boundary that differs from a normal browser-launched Shell.
const MCP_CHILD_PROBE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const app = process.env.MIRAFOLD_PACKAGED_APP;
const project = process.env.MIRAFOLD_PROBE_PROJECT;
const AMBIENT_MARKER = "MIRAFOLD_PACKAGED_AMBIENT_SMOKE=";
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function safeError(error) {
  return String(error && (error.stack || error.message) || error)
    .replace(/([?&]token=)[^\s&"'<>]+/gi, "$1<redacted>")
    .replace(/(\bpairing code\s*:\s*)[A-Za-z0-9_-]+/gi, "$1<redacted>");
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}
async function waitForExit(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}
function forceStop(pid) {
  if (!pid || !processExists(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 10000,
      windowsHide: true,
    });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}
async function within(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + timeout + "ms")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(condition, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label + " timed out after " + timeout + "ms");
}
function openSocket(WebSocket, url, origin) {
  const messages = [];
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  socket.on("message", (data) => {
    try { messages.push(JSON.parse(String(data))); } catch {}
  });
  return within(new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket, messages }));
    socket.once("error", reject);
  }), "packaged daemon WebSocket open");
}
function packagedRelative(file, label) {
  const relative = path.relative(app, file);
  invariant(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
    label + " escaped the packaged app");
  invariant(fs.statSync(file).isFile(), label + " is not a file");
  return relative.split(path.sep).join("/");
}
function verifyBootstrapAmbient() {
  const probe = path.join(project, "ambient-environment-probe.cjs");
  fs.writeFileSync(probe, [
    'const { spawnSync } = require("node:child_process");',
    'const options = { env: process.env, encoding: "utf8", windowsHide: true };',
    'const child = process.platform === "win32"',
    '  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "set ELECTRON_RUN_AS_NODE"], options)',
    '  : spawnSync("/usr/bin/env", [], options);',
    'if (child.error) throw child.error;',
    'if (child.signal !== null) throw new Error("ordinary child ended from " + child.signal);',
    'if (process.platform === "win32" && child.status !== 0 && child.status !== 1)',
    '  throw new Error("ordinary Windows child exited " + child.status);',
    'if (process.platform !== "win32" && child.status !== 0)',
    '  throw new Error("ordinary Linux child exited " + child.status);',
    'const childHasNodeMode = process.platform === "win32"',
    '  ? child.status === 0',
    '  : String(child.stdout).split(/\\r?\\n/).some((line) => line.startsWith("ELECTRON_RUN_AS_NODE="));',
    'process.stdout.write("MIRAFOLD_PACKAGED_AMBIENT_SMOKE=" + JSON.stringify({',
    '  daemonRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
    '  ordinaryChildRunAsNode: childHasNodeMode ? "present" : null,',
    '}) + "\\n");',
    '',
  ].join("\n"));

  const result = spawnSync(
    process.execPath,
    [path.join(app, "src", "daemon-bootstrap.cjs"), probe],
    {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 30000,
      windowsHide: true,
    },
  );
  invariant(!result.error, "packaged ambient probe could not run: " + result.error?.message);
  invariant(result.signal === null, "packaged ambient probe ended from " + result.signal);
  invariant(result.status === 0, "packaged ambient probe exited " + result.status + ": " + String(result.stderr).slice(-2000));
  invariant(String(result.stderr).trim() === "", "packaged ambient probe wrote stderr: " + String(result.stderr).slice(-2000));
  const reports = String(result.stdout).trim().split(/\r?\n/).filter((line) => line.startsWith(AMBIENT_MARKER));
  invariant(reports.length === 1, "packaged ambient probe returned " + reports.length + " reports instead of one");
  const report = JSON.parse(reports[0].slice(AMBIENT_MARKER.length));
  invariant(report.daemonRunAsNode === null, "packaged daemon inherited Electron Node mode");
  invariant(report.ordinaryChildRunAsNode === null, "ordinary daemon child inherited Electron Node mode");
  return report;
}

(async () => {
  invariant(app && path.isAbsolute(app), "packaged app path is not absolute");
  invariant(project && path.isAbsolute(project), "probe project path is not absolute");
  invariant(fs.statSync(project).isDirectory(), "probe project is not a directory");
  invariant(process.env.ELECTRON_RUN_AS_NODE === "1", "packaged MCP probe did not enter Electron Node mode");
  delete process.env.ELECTRON_RUN_AS_NODE;

  const requireApp = createRequire(path.join(app, "package.json"));
  const daemonModule = path.join(app, "src", "daemon.js");
  invariant(fs.statSync(daemonModule).isFile(), "packaged Desktop daemon module is missing");
  const imported = await import(pathToFileURL(daemonModule).href);
  invariant(typeof imported.Daemon === "function", "packaged Desktop daemon class is missing");
  const WsModule = requireApp("ws");
  const WebSocket = WsModule.WebSocket || WsModule;
  const { Client } = requireApp("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = requireApp("@modelcontextprotocol/sdk/client/stdio.js");

  const agentEnvReport = path.join(project, "gemini-agent-environment.txt");
  let fakeGemini;
  if (process.platform === "win32") {
    fakeGemini = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
  } else {
    fakeGemini = path.join(project, "fake-gemini");
    fs.writeFileSync(fakeGemini, [
      "#!/bin/sh",
      'if [ -n "$ELECTRON_RUN_AS_NODE" ]; then',
      '  printf present > "$MIRAFOLD_AGENT_ENV_REPORT"',
      "else",
      '  printf absent > "$MIRAFOLD_AGENT_ENV_REPORT"',
      "fi",
      "exit 64",
      "",
    ].join("\n"));
    fs.chmodSync(fakeGemini, 0o700);
  }
  invariant(fs.statSync(fakeGemini).isFile(), "fake Gemini executable is missing");
  process.env.GEMINI_API_KEY = "mirafold-packaged-smoke-no-inference";
  process.env.MIRAFOLD_GEMINI_BIN = fakeGemini;
  process.env.MIRAFOLD_AGENT_ENV_REPORT = agentEnvReport;
  process.env.MIRAFOLD_LOG_FILE = "";
  process.env.MIRAFOLD_LOCAL_DISCOVERY = "off";
  process.env.MIRAFOLD_RELAY_URL = "off";
  process.env.MIRAFOLD_SESSION_DIR = path.join(project, "sessions");
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = path.join(project, "workspace-trust.json");

  let crash = null;
  const daemon = new imported.Daemon((info) => { crash = info; });
  let socket = null;
  try {
    const rawUrl = await daemon.start(project);
    const parsed = new URL(rawUrl);
    const socketUrl = new URL(rawUrl);
    socketUrl.protocol = "ws:";
    socketUrl.pathname = "/ws";
    const opened = await openSocket(WebSocket, socketUrl, parsed.origin);
    socket = opened.socket;
    const messages = opened.messages;
    await waitFor(() => messages.find((message) => message.type === "agents"), "packaged daemon agents hello");
    socket.send(JSON.stringify({ type: "create", agent: "gemini-cli", cwd: project }));
    await waitFor(() => messages.find((message) => message.type === "session_created"), "packaged Gemini session creation");
    socket.send(JSON.stringify({ type: "prompt", text: "write the packaged renderer launch config" }));

    const settingsFile = path.join(project, ".gemini", "settings.json");
    let trustAnswered = false;
    await waitFor(() => {
      if (fs.existsSync(settingsFile)) return true;
      const permission = messages.find((message) => message.type === "permission_request");
      if (permission && !trustAnswered) {
        trustAnswered = true;
        socket.send(JSON.stringify({ type: "permission_response", id: permission.id, allow: true }));
      }
      return false;
    }, "packaged Gemini render-MCP settings");

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const launch = settings?.mcpServers?.mirafold;
    invariant(launch && typeof launch === "object", "packaged Gemini settings omitted Mirafold MCP");
    invariant(launch.command === process.execPath, "packaged adapter did not select the Electron executable");
    invariant(Array.isArray(launch.args) && launch.args.length === 1, "packaged adapter render-MCP args differ");
    const renderMcp = launch.args[0];
    const renderMcpEntry = packagedRelative(renderMcp, "render-MCP entry");
    const childOverrides = launch.env === undefined ? {} : launch.env;
    invariant(childOverrides && typeof childOverrides === "object" && !Array.isArray(childOverrides),
      "packaged adapter MCP environment is not an object");
    const adapterEnvKeys = Object.keys(childOverrides).sort();
    const adapterEnvPresent = childOverrides.ELECTRON_RUN_AS_NODE === "1";

    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: project,
      env: { ...process.env, ...childOverrides },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr.setEncoding("utf8");
    transport.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const client = new Client({ name: "mirafold-packaged-smoke", version: "0.0.0" });
    let childPid = null;
    let initialized = false;
    let tools = [];
    let renderIdValid = false;
    let probeError = null;
    let closeError = null;
    try {
      await within(client.connect(transport), "MCP initialize");
      initialized = true;
      childPid = transport.pid;
      invariant(Number.isInteger(childPid) && childPid > 0, "render-MCP transport reported no child PID");
      tools = (await within(client.listTools(), "MCP tools/list")).tools;
      const result = await within(client.callTool({
        name: "render_card",
        arguments: { title: "Packaged MCP smoke", body: "Electron child mode is isolated." },
      }), "MCP tools/call render_card");
      const renderId = result?.structuredContent?.renderId;
      renderIdValid = typeof renderId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(renderId);
    } catch (error) {
      probeError = error;
    } finally {
      childPid ??= transport.pid;
      try { await client.close(); } catch (error) { closeError = error; }
    }

    let rendererStopped = childPid ? await waitForExit(childPid, 5000) : true;
    if (!rendererStopped && childPid) {
      forceStop(childPid);
      rendererStopped = await waitForExit(childPid, 5000);
    }
    if (probeError) {
      throw new Error(
        safeError(probeError)
          + (stderr.trim() ? "\nrender-MCP stderr: " + stderr.trim() : "")
          + "\ncommand=" + launch.command
          + "\nargs=" + JSON.stringify(launch.args)
          + "\nchildEnvKeys=" + JSON.stringify(adapterEnvKeys)
          + "\nrendererStopped=" + rendererStopped,
      );
    }
    invariant(!closeError, "MCP client close failed: " + safeError(closeError));
    invariant(initialized, "MCP initialize did not complete");
    invariant(adapterEnvPresent, "packaged adapter omitted the render-MCP Electron child override");
    invariant(adapterEnvKeys.length === 1 && adapterEnvKeys[0] === "ELECTRON_RUN_AS_NODE",
      "packaged adapter supplied unexpected render-MCP environment keys: " + JSON.stringify(adapterEnvKeys));
    invariant(tools.length === 18, "render-MCP advertised " + tools.length + " tools instead of 18");
    invariant(tools.some((tool) => tool.name === "render_card"), "render-MCP omitted render_card");
    invariant(renderIdValid, "render_card returned an invalid render ID");
    invariant(transport.pid === null, "render-MCP transport retained its child PID after close");
    invariant(rendererStopped, "render-MCP child remained after close");
    invariant(stderr.trim() === "", "render-MCP wrote stderr: " + stderr.trim());
    invariant(process.env.ELECTRON_RUN_AS_NODE === undefined, "MCP child mode leaked into the probe environment");
    const ambient = verifyBootstrapAmbient();
    let agentRunAsNode = ambient.ordinaryChildRunAsNode;
    if (process.platform !== "win32") {
      await waitFor(() => fs.existsSync(agentEnvReport), "packaged Gemini agent environment report", 5000);
      agentRunAsNode = fs.readFileSync(agentEnvReport, "utf8") === "present" ? "present" : null;
    }
    invariant(agentRunAsNode === null, "packaged Gemini agent inherited Electron Node mode");

    socket.close();
    socket = null;
    const stopped = await daemon.stop();
    invariant(stopped === true, "Desktop could not stop the packaged MCP probe daemon tree");
    invariant(crash === null, "packaged MCP probe daemon reported a crash");

    process.stdout.write(${JSON.stringify(MCP_MARKER)} + JSON.stringify({
      renderMcpEntry,
      adapterEnvPresent,
      adapterEnvKeys,
      initialized: true,
      tools: tools.length,
      hasRenderCard: true,
      renderIdValid: true,
      rendererStopped: true,
      daemonTreeStopped: true,
      probeRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      daemonRunAsNode: ambient.daemonRunAsNode,
      agentRunAsNode,
      ordinaryChildRunAsNode: ambient.ordinaryChildRunAsNode,
    }) + "\n");
  } finally {
    if (socket) socket.close();
    if (daemon.running) await daemon.stop();
  }
})().catch((error) => {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
});
`;

// Runs inside the packaged Electron executable under ELECTRON_RUN_AS_NODE.
// Importing Desktop's own Daemon class is deliberate: the hosted proof must
// exercise the exact spawn, URL parsing, credential redaction, and process-tree
// shutdown code the GUI uses, not a second approximation of that lifecycle.
const DAEMON_CHILD_PROBE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
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

function settleWithin(promise, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function verifyWindowsCrashOwnership(imported) {
  const readyFile = path.join(project, "windows-crash-child.json");
  const stageFile = path.join(project, "windows-crash-stage.txt");
  const fakeDaemon = path.join(project, "windows-crash-daemon.cjs");
  fs.writeFileSync(fakeDaemon, [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const { createRequire } = require("node:module");',
    'const path = require("node:path");',
    'const stage = (value) => writeFileSync(process.env.MIRAFOLD_JOB_CRASH_STAGE, value);',
    'stage("fake-daemon-started");',
    'const commandPrompt = path.join(process.env.SystemRoot, "System32", "cmd.exe");',
    'const requireApp = createRequire(path.join(process.env.MIRAFOLD_PACKAGED_APP, "package.json"));',
    'const pty = requireApp("@lydell/node-pty");',
    'stage("node-pty-loaded");',
    'const terminal = pty.spawn(commandPrompt, ["/d", "/s", "/c", "echo JOB_PTY_OK"],',
    '  { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });',
    'stage("conpty-spawned");',
    'let ptyOutput = "";',
    'let crashStarted = false;',
    'function startCrashChild() {',
    '  if (crashStarted || !ptyOutput.includes("JOB_PTY_OK")) return;',
    '  crashStarted = true;',
    '  stage("conpty-output-observed");',
    '  try { terminal.kill(); } catch {}',
    '  // An ordinary child is re-parented when this process crashes but stays',
    '  // in the immediate Job. Node detached mode can escape a hosted nested Job.',
    '  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 60000)"],',
    '    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", windowsHide: true });',
    '  child.once("error", () => process.exit(73));',
    '  child.once("spawn", () => {',
    '    child.unref();',
    '    stage("crash-child-spawned");',
    '    writeFileSync(process.env.MIRAFOLD_JOB_CRASH_READY, JSON.stringify({',
    '      pid: child.pid,',
    '      runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
    '      conptyWorkedInsideJob: true,',
    '    }));',
    '    setTimeout(() => process.exit(23), 100);',
    '  });',
    '}',
    'terminal.onData((data) => {',
    '  ptyOutput += data;',
    '  startCrashChild();',
    '});',
    'terminal.onExit(({ exitCode }) => {',
    '  if (crashStarted) return;',
    '  if (exitCode !== 0) process.exit(72);',
    '  startCrashChild();',
    '  if (!crashStarted) process.exit(72);',
    '});',
    'setTimeout(() => {',
    '  if (crashStarted) return;',
    '  process.stderr.write("Windows ConPTY produced no output inside the Job Object\\n");',
    '  process.exit(74);',
    '}, 5000);',
    '',
  ].join("\n"));

  const launch = imported.daemonLaunchSpec({
    platform: "win32",
    executable: process.execPath,
    bootstrapEntry: path.join(app, "src", "daemon-bootstrap.cjs"),
    daemonEntry: fakeDaemon,
    windowsJobEntry: path.join(app, "src", "windows-daemon-job.ps1"),
    env: {
      ...process.env,
      MIRAFOLD_DESKTOP_WINDOWS_STOP_EVENT: "Local\\MirafoldDesktopStop-" + randomUUID(),
      MIRAFOLD_JOB_CRASH_READY: readyFile,
      MIRAFOLD_JOB_CRASH_STAGE: stageFile,
    },
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

  try {
    // Runtime Add-Type compilation crossed one minute under the loaded hosted
    // Windows suite. This second wrapper receives Desktop's same bounded
    // two-minute wrapper-readiness phase.
    const readyDeadline = Date.now() + 120_000;
    while (!fs.existsSync(readyFile) && outcome === null && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    let stage = "wrapper-started; fake daemon did not record a stage";
    try { stage = fs.readFileSync(stageFile, "utf8"); } catch {}
    invariant(fs.existsSync(readyFile), "Windows crash child did not start (stage: " + stage + "): " + stderr);
    const report = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    invariant(Number.isInteger(report.pid) && report.pid > 0, "Windows crash child reported no PID");
    invariant(report.runAsNode === null, "Windows crash child inherited Electron Node mode");
    invariant(report.conptyWorkedInsideJob === true, "Windows ConPTY failed inside the Job Object");

    const wrapperResult = outcome ?? await settleWithin(closed, 15000);
    invariant(wrapperResult !== null, "Windows Job Object wrapper did not exit: " + stderr);
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
        timeout: 10000,
        windowsHide: true,
      });
    }
    invariant(stopped, "Windows Job Object left crash descendant " + report.pid + " running");
    return true;
  } finally {
    // A failed readiness/exit assertion must not leave the wrapper (and its
    // deliberately long-lived descendant) holding this headless probe open.
    if (outcome === null) {
      try { wrapper.kill(); } catch {}
      if (await settleWithin(closed, 5000) === null && wrapper.pid) {
        spawnSync("taskkill.exe", ["/PID", String(wrapper.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 10000,
          windowsHide: true,
        });
        wrapper.stderr.destroy();
        wrapper.unref();
      }
    }
  }
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
  }, 390_000);

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
    // Only the real packaged application carries the launch-spec, bootstrap,
    // Job wrapper, and genuine node-pty this proof needs; the caller decides
    // (2026-08-14: the first native Windows run showed a bare platform check
    // here made the minimal fixture app fail on Windows runners).
    const windowsCrashTreeStopped = process.platform === "win32"
      && process.env.MIRAFOLD_PROBE_CRASH_OWNERSHIP === "1"
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
  if (result.error) {
    const diagnostic = String(result.stderr ?? "").trim().slice(-4000);
    throw new Error(`${label} could not run: ${result.error.message}${diagnostic ? `: ${diagnostic}` : ""}`);
  }
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

export function runPackagedMcpProbe({
  executable,
  appDirectory,
  spawn = spawnSync,
  temporaryDirectory = tmpdir(),
} = {}) {
  validatePackagedPaths(executable, appDirectory);
  invariant(typeof temporaryDirectory === "string" && path.isAbsolute(temporaryDirectory), "probe temp path must be absolute");
  invariant(lstatSync(temporaryDirectory).isDirectory(), "probe temp path must be a directory");

  const probeRoot = mkdtempSync(path.join(temporaryDirectory, "mirafold-packaged-mcp-"));
  const project = path.join(probeRoot, "project");
  mkdirSync(project);
  try {
    const result = spawn(executable, ["--eval", MCP_CHILD_PROBE], {
      cwd: project,
      encoding: "utf8",
      env: minimalEnvironment(appDirectory, { MIRAFOLD_PROBE_PROJECT: project }),
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 90000,
      windowsHide: true,
    });
    assertCredentialSafe(String(result.stdout), "packaged MCP stdout");
    assertCredentialSafe(String(result.stderr), "packaged MCP stderr");
    spawnResult(result, "packaged MCP probe");
    invariant(String(result.stderr).trim() === "", `packaged MCP probe wrote stderr: ${String(result.stderr).slice(-4000)}`);
    const report = parseMarkedReport(result.stdout, MCP_MARKER, "packaged MCP probe");
    invariant(
      typeof report.renderMcpEntry === "string"
        && report.renderMcpEntry.endsWith("/mirafold/dist-server/render-mcp.js"),
      "packaged render-MCP entry differs",
    );
    invariant(report.adapterEnvPresent === true, "packaged adapter omitted the render-MCP child environment");
    invariant(
      Array.isArray(report.adapterEnvKeys)
        && report.adapterEnvKeys.length === 1
        && report.adapterEnvKeys[0] === "ELECTRON_RUN_AS_NODE",
      "packaged adapter render-MCP environment keys differ",
    );
    invariant(report.initialized === true, "packaged render-MCP did not initialize");
    invariant(report.tools === 18, "packaged render-MCP tool count differs");
    invariant(report.hasRenderCard === true, "packaged render-MCP omitted render_card");
    invariant(report.renderIdValid === true, "packaged render_card ID is invalid");
    invariant(report.rendererStopped === true, "packaged render-MCP process remained");
    invariant(report.daemonTreeStopped === true, "packaged MCP probe daemon tree remained");
    invariant(report.probeRunAsNode === null, "packaged MCP child mode leaked into its parent");
    invariant(report.daemonRunAsNode === null, "packaged daemon ambient environment kept Electron Node mode");
    invariant(report.agentRunAsNode === null, "packaged Gemini agent inherited Electron Node mode");
    invariant(report.ordinaryChildRunAsNode === null, "ordinary daemon child inherited Electron Node mode");
    return report;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
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

  // The Windows crash-ownership proof needs the complete packaged surface —
  // launch spec, bootstrap, Job wrapper, real node-pty — so it applies exactly
  // where the true-report requirement below applies: the real Mirafold.exe.
  const requireWindowsCrashOwnership = (platform === "win32" || platform === "windows")
    && path.basename(executable).toLowerCase() === "mirafold.exe";

  const probeRoot = mkdtempSync(path.join(temporaryDirectory, "mirafold-packaged-daemon-"));
  const project = path.join(probeRoot, "project");
  mkdirSync(project);
  try {
    const result = spawn(executable, ["--eval", DAEMON_CHILD_PROBE], {
      cwd: project,
      encoding: "utf8",
      env: minimalEnvironment(appDirectory, {
        MIRAFOLD_PROBE_CRASH_OWNERSHIP: requireWindowsCrashOwnership ? "1" : "0",
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
      timeout: 420_000,
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

    if (requireWindowsCrashOwnership) {
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
  const renderMcp = runPackagedMcpProbe({
    executable,
    appDirectory,
    spawn,
    temporaryDirectory,
  });
  const daemonLifecycle = runPackagedDaemonProbe({
    executable,
    appDirectory,
    spawn,
    platform,
    temporaryDirectory,
  });
  return { ...identity, renderMcp, daemonLifecycle };
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
