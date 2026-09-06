import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Daemon,
  daemonLaunchSpec,
  findStartupUrl,
  sendDesktopCredential,
} from "../src/daemon.js";
import { LinuxProcessTreeTracker, terminateProcessTree } from "../src/process-tree.js";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");
const KEY = `mf_${"e".repeat(26)}`;
const AMBIENT = `mf_${"f".repeat(26)}`;
const TOKEN = "fixture.entitlement.token";
const LINUX = process.platform === "linux" ? false : "Linux private-pipe and process-metadata proof";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function processIsRunning(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function waitFor(read, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${message} timed out after ${timeoutMs}ms`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function controlledEnvironment(root, additions = {}) {
  const { PORT: port, ...rest } = additions;
  return {
    PATH: process.env.PATH ?? "",
    HOME: root,
    LANG: "C.UTF-8",
    PORT: String(port),
    MIRAFOLD_AGENT: "claude-code",
    MIRAFOLD_LOCAL_DISCOVERY: "off",
    MIRAFOLD_LOCAL_ENDPOINTS: "",
    MIRAFOLD_LOG_FILE: "",
    MIRAFOLD_SESSION_DIR: path.join(root, "sessions"),
    MIRAFOLD_WORKSPACE_TRUST_FILE: path.join(root, "workspace-trust.json"),
    ...rest,
  };
}

function isDotenvName(name) {
  return name === ".env"
    || name.endsWith(".env")
    || name.startsWith(".env.")
    || name.includes(".env.");
}

function assertSecretsAbsentFromTree(root, secrets) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (isDotenvName(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile() || statSync(target).size > 1024 * 1024) continue;
      const bytes = readFileSync(target);
      for (const secret of secrets) {
        assert.equal(bytes.includes(Buffer.from(secret)), false, `${target} retained a credential`);
      }
    }
  };
  visit(root);
}

async function startPublishedShell(t, additions = {}, licenseKey) {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-desktop-handoff-"));
  const ledgerFile = path.join(root, "owned-processes");
  writeFileSync(ledgerFile, "", { mode: 0o600 });
  const env = controlledEnvironment(root, {
    PORT: await freePort(),
    MIRAFOLD_DESKTOP_PID_LEDGER: ledgerFile,
    ...additions,
  });
  const daemonEntry = require.resolve("mirafold/dist-server/index.js");
  const launch = daemonLaunchSpec({
    platform: "linux",
    executable: process.execPath,
    daemonEntry,
    env,
  });
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env: launch.env,
    detached: launch.detached,
    stdio: [launch.stdin, "pipe", "pipe"],
  });
  const privateInputTarget = readlinkSync(`/proc/${child.pid}/fd/0`);
  const tracker = new LinuxProcessTreeTracker(child.pid, 25, ledgerFile);
  const closed = once(child, "close");
  let output = "";
  let stopped = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => { output += text; });
  child.stderr.on("data", (text) => { output += text; });

  const startup = waitFor(() => findStartupUrl(output), "published Shell startup");
  try {
    const [, url] = await Promise.all([
      sendDesktopCredential(child, licenseKey),
      startup,
    ]);
    const stop = async () => {
      if (stopped) return true;
      stopped = true;
      const identities = tracker.stop();
      const clean = await terminateProcessTree(child.pid, identities, {
        ledgerFile,
        termTimeoutMs: 250,
        killTimeoutMs: 2_000,
      });
      await closed;
      return clean;
    };
    t.after(async () => {
      if (!stopped) await stop();
      rmSync(root, { recursive: true, force: true });
    });
    return { child, env, launch, output: () => output, privateInputTarget, root, stop, url };
  } catch (error) {
    const identities = tracker.stop();
    await terminateProcessTree(child.pid, identities, {
      ledgerFile,
      termTimeoutMs: 0,
      killTimeoutMs: 2_000,
    });
    await closed;
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function openClient(t, rawUrl) {
  const httpUrl = new URL(rawUrl);
  const socketUrl = new URL(rawUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/ws";
  socketUrl.hash = "";
  const socket = new WebSocket(socketUrl, { headers: { Origin: httpUrl.origin } });
  const messages = [];
  socket.on("message", (data) => {
    try {
      messages.push(JSON.parse(String(data)));
    } catch {
      // Ignore a malformed message here; the expected typed message will time out.
    }
  });
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  t.after(() => socket.terminate());
  return {
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: (predicate, label) => waitFor(() => messages.find(predicate), label),
  };
}

async function privateServices(t) {
  const calls = [];
  const service = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 1024) {
        req.destroy();
        return;
      }
    }
    let bodyDigest = null;
    try {
      bodyDigest = digest(JSON.parse(body).licenseKey);
    } catch {
      // The assertion below reports this fixed null rather than request text.
    }
    calls.push({ path: req.url, bodyDigest });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/entitlement") {
      res.end(JSON.stringify({ token: TOKEN, exp: Math.floor(Date.now() / 1000) + 3600 }));
    } else if (req.url === "/api/subscription") {
      res.end(JSON.stringify({ status: "active" }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  const relay = new WebSocketServer({ server: service });
  const relayHeaders = [];
  relay.on("connection", (socket, request) => {
    relayHeaders.push(request.headers["mirafold-entitlement"] ?? null);
    socket.on("error", () => {});
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const address = service.address();
  assert.ok(address && typeof address === "object");
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const client of relay.clients) client.terminate();
    await new Promise((resolve) => relay.close(() => resolve()));
    await new Promise((resolve, reject) => service.close((error) => error ? reject(error) : resolve()));
  };
  t.after(stop);
  return {
    calls,
    entitlementUrl: `http://127.0.0.1:${address.port}/api/entitlement`,
    relayHeaders,
    relayUrl: `ws://127.0.0.1:${address.port}`,
    stop,
  };
}

function assertProcessMetadataHasNoCredential(pid, secrets, privateInputTarget) {
  const sources = [
    readFileSync(`/proc/${pid}/environ`),
    readFileSync(`/proc/${pid}/cmdline`),
  ];
  for (const source of sources) {
    for (const secret of secrets) {
      assert.equal(source.includes(Buffer.from(secret)), false, "daemon process metadata retained a credential");
    }
  }
  const descriptor = `/proc/${pid}/fd/0`;
  const currentTarget = existsSync(descriptor) ? readlinkSync(descriptor) : null;
  assert.notEqual(
    currentTarget,
    privateInputTarget,
    `Shell kept its original private input ${privateInputTarget} open`,
  );
}

function childProbeSource() {
  return [
    'import { createHash } from "node:crypto";',
    'import { fstatSync, readFileSync } from "node:fs";',
    'const expected = new Set(process.argv.slice(2));',
    'const hash = (value) => createHash("sha256").update(value).digest("hex");',
    'const contains = (value) => (String(value).match(/mf_[a-z2-7]{20,40}/g) ?? []).some((key) => expected.has(hash(key)));',
    'let privatePipeOpen = false;',
    'try { const stat = fstatSync(0); privatePipeOpen = stat.isFIFO() || stat.isSocket(); } catch {}',
    'const report = {',
    '  env: Object.values(process.env).some(contains),',
    '  argv: process.argv.some(contains),',
    '  osEnv: contains(readFileSync("/proc/self/environ")),',
    '  osArgv: contains(readFileSync("/proc/self/cmdline")),',
    '  privatePipeOpen,',
    '};',
    'process.stdout.write(`MIRAFOLD_CHILD_PROBE=${JSON.stringify(report)}\\n`);',
    '',
  ].join("\n");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

test("the Desktop package resolves the exact locked published Shell", () => {
  const desktop = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const shellPackagePath = require.resolve("mirafold/package.json");
  const shell = JSON.parse(readFileSync(shellPackagePath, "utf8"));
  const locked = lock.packages["node_modules/mirafold"];

  assert.match(desktop.dependencies.mirafold, /^\d+\.\d+\.\d+$/);
  assert.equal(shell.version, desktop.dependencies.mirafold);
  assert.equal(locked.version, desktop.dependencies.mirafold);
  assert.match(locked.resolved, /^https:\/\/registry\.npmjs\.org\/mirafold\/-\/mirafold-/);
  assert.match(locked.integrity, /^sha512-/);
  assert.equal(
    require.resolve("mirafold/dist-server/index.js"),
    path.join(path.dirname(shellPackagePath), "dist-server", "index.js"),
  );
});

test("Daemon.start delivers its stored key through the production launch path", { skip: LINUX }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-desktop-daemon-start-"));
  const services = await privateServices(t);
  const env = controlledEnvironment(root, {
    PORT: await freePort(),
    MIRAFOLD_LICENSE_KEY: AMBIENT,
    MIRAFOLD_ENTITLEMENT_URL: services.entitlementUrl,
    MIRAFOLD_RELAY_URL: services.relayUrl,
  });
  let output = "";
  let crash = null;
  const daemon = new Daemon((info) => { crash = info; }, {
    loadEnv: async () => env,
    writeStderr: (text) => { output += text; },
    writeStdout: (text) => { output += text; },
  });
  t.after(async () => {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const url = await daemon.start(root, { licenseKey: KEY });
  const client = await openClient(t, url);
  const hello = await client.waitFor((message) => message.type === "agents", "production-path hello");
  assert.equal(hello.host, "desktop");
  assert.equal(hello.billing, "license-key");
  client.send({ type: "subscription_status", id: "production-path" });
  const subscription = await client.waitFor(
    (message) => message.type === "subscription" && message.id === "production-path",
    "production-path subscription",
  );
  assert.equal(subscription.status, "active");
  await waitFor(() => services.calls.length >= 2, "production-path entitlement and billing calls");
  assert.deepEqual(services.calls.map((call) => call.bodyDigest), [digest(KEY), digest(KEY)]);
  assert.equal(crash, null);
  assert.ok(!output.includes(KEY) && !output.includes(AMBIENT));
  assert.equal(await daemon.stop(), true);
});

test("published Shell receives only the pipe key for entitlement, billing, and a real child", { skip: LINUX }, async (t) => {
  const services = await privateServices(t);
  const run = await startPublishedShell(t, {
    MIRAFOLD_LICENSE_KEY: AMBIENT,
    MIRAFOLD_ENTITLEMENT_URL: services.entitlementUrl,
    MIRAFOLD_RELAY_URL: services.relayUrl,
    MIRAFOLD_APP_URL: "https://app.invalid",
  }, KEY);
  const client = await openClient(t, run.url);
  const hello = await client.waitFor((message) => message.type === "agents", "Desktop agents hello");

  assert.equal(hello.host, "desktop");
  assert.equal(hello.billing, "license-key");
  await waitFor(() => services.relayHeaders.length > 0, "entitled relay dial");
  assert.deepEqual(services.relayHeaders, [TOKEN]);
  client.send({ type: "subscription_status", id: "status" });
  const subscription = await client.waitFor(
    (message) => message.type === "subscription" && message.id === "status",
    "subscription status",
  );
  assert.equal(subscription.status, "active");
  await waitFor(() => services.calls.length >= 2, "entitlement and billing calls");
  assert.deepEqual(
    services.calls.map((call) => call.path).sort(),
    ["/api/entitlement", "/api/subscription"],
  );
  assert.deepEqual(
    services.calls.map((call) => call.bodyDigest),
    [digest(KEY), digest(KEY)],
  );

  assert.equal(Object.hasOwn(run.launch.env, "MIRAFOLD_LICENSE_KEY"), false);
  assert.equal(run.env.MIRAFOLD_LICENSE_KEY, AMBIENT, "launch construction did not mutate its input");
  assertProcessMetadataHasNoCredential(run.child.pid, [KEY, AMBIENT], run.privateInputTarget);

  client.send({ type: "create", agent: "claude-code", cwd: run.root });
  await client.waitFor((message) => message.type === "session_created", "local mock session");
  const probe = path.join(run.root, "child-probe.mjs");
  writeFileSync(probe, childProbeSource(), { mode: 0o600 });
  const command = [process.execPath, probe, digest(KEY), digest(AMBIENT)].map(shellQuote).join(" ");
  client.send({ type: "bang", id: "child-boundary", command });
  await client.waitFor(
    (message) => message.type === "bang_end" && message.id === "child-boundary",
    "child process boundary",
  );
  const bangOutput = client.messages
    .filter((message) => message.type === "bang_output" && message.id === "child-boundary")
    .map((message) => message.data)
    .join("");
  const match = /MIRAFOLD_CHILD_PROBE=(\{[^\r\n]+\})/.exec(bangOutput);
  assert.ok(match, "real child did not return its process-boundary report");
  assert.deepEqual(JSON.parse(match[1]), {
    env: false,
    argv: false,
    osEnv: false,
    osArgv: false,
    privatePipeOpen: false,
  });

  const allOutput = `${run.output()}\n${JSON.stringify(client.messages)}`;
  assert.ok(!allOutput.includes(KEY) && !allOutput.includes(AMBIENT));
  assertSecretsAbsentFromTree(run.root, [KEY, AMBIENT]);
  assert.equal(await run.stop(), true);
  assert.equal(processIsRunning(run.child.pid), false);
});

test("an empty Desktop pipe preserves free local use and activation host identity", { skip: LINUX }, async (t) => {
  const run = await startPublishedShell(t, { MIRAFOLD_LICENSE_KEY: AMBIENT });
  const client = await openClient(t, run.url);
  const hello = await client.waitFor((message) => message.type === "agents", "unactivated Desktop hello");

  assert.equal(hello.host, "desktop");
  assert.equal(hello.relayOff, "unentitled");
  assert.equal(Object.hasOwn(hello, "billing"), false);
  assert.match(run.output(), /Desktop Pro credential unavailable \(missing-input\)/);
  assertProcessMetadataHasNoCredential(run.child.pid, [AMBIENT], run.privateInputTarget);

  client.send({ type: "create", agent: "claude-code", cwd: run.root });
  await client.waitFor((message) => message.type === "session_created", "free local session");
  client.send({ type: "prompt", text: "hello" });
  await client.waitFor((message) => message.type === "turn_end", "free local turn");
  assert.ok(client.messages.some((message) => message.type === "text_delta"));
  assert.ok(!run.output().includes(AMBIENT));
  assert.ok(!JSON.stringify(client.messages).includes(AMBIENT));
  assert.equal(await run.stop(), true);
});

test("a daemon that exits during startup has its complete Linux process tree retired", { skip: LINUX }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-desktop-early-exit-"));
  const readyFile = path.join(root, "descendant-pid");
  const daemonEntry = path.join(root, "early-exit.mjs");
  writeFileSync(daemonEntry, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'writeFileSync(process.env.PROBE_READY_FILE, String(descendant.pid));',
    'setTimeout(() => process.exit(17), 100);',
    '',
  ].join("\n"));
  const daemon = new Daemon(() => {
    throw new Error("startup failure must not become a post-start crash");
  }, {
    loadEnv: async () => controlledEnvironment(root, {
      PORT: await freePort(),
      PROBE_READY_FILE: readyFile,
      MIRAFOLD_LICENSE_KEY: AMBIENT,
    }),
    resolveDaemonEntry: () => daemonEntry,
  });
  let descendantPid = null;
  try {
    await assert.rejects(
      daemon.start(root, { licenseKey: KEY }),
      /daemon exited \(code 17\) before starting/,
    );
    assert.ok(existsSync(readyFile), "the early-exit fixture never created its descendant");
    descendantPid = Number(readFileSync(readyFile, "utf8"));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await waitFor(() => !processIsRunning(descendantPid), "early-exit descendant cleanup", 5_000);
    assert.equal(daemon.running, false);
  } finally {
    await daemon.stop();
    if (descendantPid && processIsRunning(descendantPid)) process.kill(descendantPid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
