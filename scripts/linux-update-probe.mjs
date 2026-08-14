#!/usr/bin/env node

// Destructive update behavior belongs in a disposable, local-only probe, not
// in the unit suite. This script serves a newly built release over loopback,
// makes electron-updater perform its real metadata/hash/download work, and
// replaces only a hard link inside a fresh temporary directory. The Debian
// privilege command is captured immediately before execution: actually
// installing a package would mutate the host and require the user's password.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "../src/daemon.js";
import { DOWNLOAD_PAGE_URL, createDesktopUpdater } from "../src/updater.js";
import { parseUpdateMetadata, verifyPlatformArtifacts } from "./release-contract.mjs";

const require = createRequire(import.meta.url);
const { AppImageUpdater, AppUpdater, DebUpdater } = require("electron-updater");
const { NodeHttpExecutor } = require("builder-util/out/nodeHttpExecutor.js");
const { configureRequestOptions, configureRequestUrl } = require("builder-util-runtime");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, label, milliseconds = 120_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fileHash(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("base64")));
  });
}

function createAppAdapter(root, label, version, feedUrl) {
  const userDataPath = path.join(root, `${label}-user-data`);
  const baseCachePath = path.join(root, `${label}-cache`);
  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(baseCachePath, { recursive: true });
  const appUpdateConfigPath = path.join(root, `${label}-app-update.yml`);
  writeFileSync(
    appUpdateConfigPath,
    [
      "provider: generic",
      `url: ${feedUrl}`,
      `updaterCacheDirName: mirafold-${label}-probe`,
      "",
    ].join("\n"),
  );

  const state = { quitCalls: 0, relaunchCalls: 0, quitHandlers: [] };
  return {
    adapter: {
      version,
      name: "Mirafold",
      isPackaged: true,
      appUpdateConfigPath,
      userDataPath,
      baseCachePath,
      whenReady: () => Promise.resolve(),
      relaunch: () => {
        state.relaunchCalls += 1;
      },
      quit: () => {
        state.quitCalls += 1;
      },
      onQuit: (handler) => state.quitHandlers.push(handler),
    },
    state,
  };
}

class LoopbackHttpExecutor extends NodeHttpExecutor {
  // NodeHttpExecutor intentionally exposes metadata requests but not the
  // download wrapper electron-updater calls. This is ElectronHttpExecutor's
  // wrapper over the same inherited doDownload checksum/file pipeline, with
  // Node's loopback request primitive retained for this headless probe.
  async download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: "manual" };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(
        requestOptions,
        {
          destination,
          options,
          onCancel,
          callback: (error) => (error == null ? resolve(destination) : reject(error)),
          responseHandler: null,
        },
        0,
      );
    });
  }
}

function attachNodeTransport(updater) {
  updater.httpExecutor = new LoopbackHttpExecutor();
  updater.disableDifferentialDownload = true;
  updater.logger = { debug() {}, info() {}, warn() {}, error() {} };
  return updater;
}

function createLoopbackUpdater(UpdaterClass, adapter, feedUrl) {
  // An injected AppAdapter makes electron-updater leave httpExecutor null.
  // Attach Node's transport before constructing the provider, because the
  // provider snapshots the executor when setFeedURL runs.
  const updater = attachNodeTransport(new UpdaterClass(null, adapter));
  updater.setFeedURL({ provider: "generic", url: feedUrl });
  return updater;
}

async function startFeed(directory, allowedNames) {
  const requests = [];
  const allowed = new Map(allowedNames.map((name) => [name, path.join(directory, name)]));
  const server = http.createServer((request, response) => {
    let name;
    try {
      name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname.slice(1));
    } catch {
      response.writeHead(400).end();
      return;
    }
    requests.push({ method: request.method, name });
    const file = allowed.get(name);
    if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    response.writeHead(200, {
      "Content-Length": size,
      "Content-Type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(file);
    stream.once("error", () => response.destroy());
    stream.pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "loopback feed did not expose an address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function localRequestSucceeds(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.once("end", () => resolve(true));
    });
    request.setTimeout(1500, () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

async function startRealDaemon(root, label) {
  const project = path.join(root, `${label}-project`);
  mkdirSync(project, { recursive: true });
  let crash = null;
  const daemon = new Daemon((info) => {
    crash = info;
  });
  // The updater proof must not create a real remote relay session. An explicit
  // process value wins over any project dotenv value without reading it. Keep
  // the daemon's saved-session store inside this probe too: a rehearsal must
  // neither read nor write the user's real session index.
  const previousRelayUrl = process.env.MIRAFOLD_RELAY_URL;
  const previousSessionDirectory = process.env.MIRAFOLD_SESSION_DIR;
  process.env.MIRAFOLD_RELAY_URL = "off";
  process.env.MIRAFOLD_SESSION_DIR = path.join(root, `${label}-sessions`);
  let url;
  try {
    url = await daemon.start(project);
  } finally {
    if (previousRelayUrl === undefined) delete process.env.MIRAFOLD_RELAY_URL;
    else process.env.MIRAFOLD_RELAY_URL = previousRelayUrl;
    if (previousSessionDirectory === undefined) delete process.env.MIRAFOLD_SESSION_DIR;
    else process.env.MIRAFOLD_SESSION_DIR = previousSessionDirectory;
  }
  invariant(await localRequestSucceeds(url), `${label} daemon URL was not reachable before update`);
  return { daemon, url, get crash() { return crash; } };
}

async function exerciseInstallController({ updater, daemonProbe, install }) {
  const messages = [];
  const lifecycle = [];
  const installed = deferred();
  // Preserve a direct rejected Promise for the later assertion while marking
  // it handled immediately if electron-updater emits an asynchronous error.
  void installed.promise.catch(() => {});
  updater.quitAndInstall = (...args) => {
    try {
      lifecycle.push("install");
      assert.equal(daemonProbe.daemon.running, false, "platform installer ran before daemon.stop completed");
      installed.resolve({ args, result: install(...args) });
    } catch (error) {
      installed.reject(error);
    }
  };
  updater.on("error", (error) => installed.reject(error));

  const controller = createDesktopUpdater({
    isPackaged: true,
    isWindowsStore: false,
    desktopVersion: updater.app.version,
    shellVersion: require(path.join(ROOT, "node_modules/mirafold/package.json")).version,
    updateStrategy: "install",
    loadUpdater: async () => updater,
    showMessage: async (message) => {
      messages.push(message);
      return { response: 0 };
    },
    prepareInstall: async () => {
      lifecycle.push("prepare");
      const clean = await daemonProbe.daemon.stop();
      assert.equal(clean, true, "daemon process tree shutdown was not proven");
      assert.equal(await localRequestSucceeds(daemonProbe.url), false, "daemon URL remained reachable after stop proof");
      lifecycle.push("stopped");
      return true;
    },
    recoverInstall: async () => {
      lifecycle.push("recover");
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const checked = await controller.checkManually();
  assert.equal(checked?.isUpdateAvailable, true, "local feed did not report the higher version");
  const outcome = await withTimeout(installed.promise, "local update install");
  assert.deepEqual(lifecycle, ["prepare", "stopped", "install"]);
  assert.deepEqual(outcome.args, [false, true]);
  assert.equal(outcome.result, true, "platform updater refused the downloaded artifact");
  assert.equal(daemonProbe.crash, null, "an intentional update shutdown was reported as a daemon crash");
  assert.ok(messages.some((message) => message.title === "Mirafold update ready"));
  return { lifecycle, messages };
}

async function exerciseAppImage({ root, oldAppImage, feedDirectory, feedUrl, oldVersion, newVersion }) {
  const currentDirectory = path.join(root, "appimage-current");
  mkdirSync(currentDirectory, { recursive: true });
  const currentPath = path.join(currentDirectory, path.basename(oldAppImage));
  linkSync(oldAppImage, currentPath);
  const previousAppImage = process.env.APPIMAGE;
  process.env.APPIMAGE = currentPath;

  const { adapter } = createAppAdapter(root, "appimage", oldVersion, feedUrl);
  const updater = createLoopbackUpdater(AppImageUpdater, adapter, feedUrl);
  let launch = null;
  updater.spawnLog = async (command, args, env) => {
    launch = { command, args, silentInstall: env?.APPIMAGE_SILENT_INSTALL };
    return true;
  };
  const daemonProbe = await startRealDaemon(root, "appimage");
  try {
    const controller = await exerciseInstallController({
      updater,
      daemonProbe,
      install: (isSilent, isForceRunAfter) => updater.install(isSilent, isForceRunAfter),
    });
    const newName = `Mirafold-${newVersion}.AppImage`;
    const destination = path.join(currentDirectory, newName);
    const feedArtifact = path.join(feedDirectory, newName);
    assert.equal(statSync(destination).mode & 0o111, 0o111, "replacement AppImage lost executable mode");
    assert.equal(await fileHash(destination), await fileHash(feedArtifact), "replacement AppImage differs from verified download");
    assert.equal(launch?.command, destination, "updater did not relaunch the replacement AppImage path");
    assert.equal(launch?.silentInstall, "true");
    assert.equal(statSync(oldAppImage).size > 0, true, "probe modified the source old-version artifact");
    return {
      lifecycle: controller.lifecycle,
      replacedOldName: !existsSync(currentPath),
      replacementName: newName,
      replacementBytes: statSync(destination).size,
      elevation: "none; replacement occurred inside a user-writable directory",
      relaunchTargetVerified: true,
    };
  } finally {
    if (daemonProbe.daemon.running) await daemonProbe.daemon.stop();
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  }
}

async function exerciseDeb({ root, feedDirectory, feedUrl, oldVersion, newVersion }) {
  assert.notEqual(process.getuid?.(), 0, "Debian elevation probe must run as an ordinary user");
  const { adapter, state } = createAppAdapter(root, "deb", oldVersion, feedUrl);
  const updater = createLoopbackUpdater(DebUpdater, adapter, feedUrl);
  const packageManager = updater.detectPackageManager(["dpkg", "apt"]);
  const elevationCommand = updater.determineSudoCommand();
  const executions = [];
  updater.hasCommand = (command) => command === packageManager;
  updater.determineSudoCommand = () => elevationCommand;
  updater.spawnSyncLog = (command, args) => {
    executions.push({ command, args });
    return "";
  };

  const daemonProbe = await startRealDaemon(root, "deb");
  try {
    const controller = await exerciseInstallController({
      updater,
      daemonProbe,
      install: (isSilent, isForceRunAfter) => updater.install(isSilent, isForceRunAfter),
    });
    assert.equal(executions.length, 1, "Debian updater constructed more than one privileged command");
    const [execution] = executions;
    assert.equal(execution.command, elevationCommand);
    assert.ok(execution.args.includes("/bin/bash"));
    assert.ok(execution.args.some((argument) => argument.includes(`${packageManager} -i `)));
    if (elevationCommand === "pkexec") {
      assert.equal(execution.args[0], "--disable-internal-agent");
    }
    const downloadedPath = updater.installerPath;
    const feedDeb = path.join(feedDirectory, `mirafold-desktop_${newVersion}_amd64.deb`);
    assert.equal(await fileHash(downloadedPath), await fileHash(feedDeb), "downloaded Debian package hash differs");
    assert.equal(state.relaunchCalls, 1, "Debian updater did not request relaunch after its install command");
    return {
      lifecycle: controller.lifecycle,
      packageManager,
      elevationCommand,
      elevationArguments: execution.args.map((argument) => argument.replace(downloadedPath, "<verified-deb>")),
      privilegedCommandExecuted: false,
      downloadedBytes: statSync(downloadedPath).size,
    };
  } finally {
    if (daemonProbe.daemon.running) await daemonProbe.daemon.stop();
  }
}

async function exerciseTarNotice({ root, feedUrl, oldVersion, requests }) {
  const { adapter } = createAppAdapter(root, "tar", oldVersion, feedUrl);
  const updater = createLoopbackUpdater(AppUpdater, adapter, feedUrl);
  const messages = [];
  const opened = [];
  const requestStart = requests.length;
  const controller = createDesktopUpdater({
    isPackaged: true,
    isWindowsStore: false,
    desktopVersion: oldVersion,
    shellVersion: require(path.join(ROOT, "node_modules/mirafold/package.json")).version,
    updateStrategy: "manual-download",
    loadUpdater: async () => updater,
    showMessage: async (message) => {
      messages.push(message);
      return { response: 0 };
    },
    openDownloadPage: async (url) => opened.push(url),
    prepareInstall: async () => {
      throw new Error("tar notice must never prepare an in-place installation");
    },
    recoverInstall: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const checked = await controller.start();
  assert.equal(checked?.isUpdateAvailable, true);
  assert.equal(updater.autoDownload, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0].detail, /Linux \.tar\.gz archive/);
  assert.deepEqual(opened, [DOWNLOAD_PAGE_URL]);
  const ownRequests = requests.slice(requestStart);
  assert.ok(ownRequests.some((request) => request.name === "latest-linux.yml"));
  assert.equal(ownRequests.some((request) => request.name !== "latest-linux.yml"), false, "tar notice downloaded a payload");
  return {
    metadataRequests: ownRequests.length,
    payloadRequests: 0,
    opened: DOWNLOAD_PAGE_URL,
    daemonStopped: false,
  };
}

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readBridgeProbeRelease(directory, expectedVersion, expectedState) {
  const packageMetadata = JSON.parse(
    readFileSync(path.join(directory, "linux-unpacked", "resources", "app", "package.json"), "utf8"),
  );
  assert.equal(packageMetadata.version, expectedVersion, `${directory} contains the wrong packaged version`);
  assert.equal(
    packageMetadata.mirafoldBridgeProbeState,
    expectedState,
    `${directory} contains the wrong bridge-probe payload state`,
  );

  const appImageName = `Mirafold-${expectedVersion}.AppImage`;
  const appImage = path.join(directory, appImageName);
  const updateMetadata = parseUpdateMetadata(
    readFileSync(path.join(directory, "latest-linux.yml"), "utf8"),
  );
  assert.equal(updateMetadata.version, expectedVersion);
  assert.equal(updateMetadata.path, appImageName);
  assert.equal(updateMetadata.files.length, 1);
  assert.equal(updateMetadata.files[0].url, appImageName);
  assert.equal(updateMetadata.files[0].size, statSync(appImage).size);
  assert.equal(updateMetadata.sha512, updateMetadata.files[0].sha512);
  const appImageHash = await fileHash(appImage);
  assert.equal(updateMetadata.sha512, appImageHash, `${appImageName} differs from its update metadata`);

  return {
    directory,
    version: expectedVersion,
    state: expectedState,
    appImage,
    appImageName,
    appImageHash,
    updaterHash: await fileHash(
      path.join(directory, "linux-unpacked", "resources", "app", "src", "updater.js"),
    ),
  };
}

function runPackagedIdentityProbe(release) {
  const executable = path.join(release.directory, "linux-unpacked", "mirafold");
  const script = [
    'const path = require("node:path")',
    'const metadata = require(path.join(process.resourcesPath, "app", "package.json"))',
    "process.stdout.write(JSON.stringify({ version: metadata.version, state: metadata.mirafoldBridgeProbeState }))",
  ].join(";");
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["PATH", "LD_LIBRARY_PATH", "LANG"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const identity = JSON.parse(execFileSync(executable, ["-e", script], { encoding: "utf8", env }));
  assert.deepEqual(identity, { version: release.version, state: release.state });
  return identity;
}

function createBadChecksumFeed(root, release) {
  const directory = path.join(root, "bad-checksum-feed");
  mkdirSync(directory, { recursive: true });
  linkSync(release.appImage, path.join(directory, release.appImageName));
  const validMetadata = readFileSync(path.join(release.directory, "latest-linux.yml"), "utf8");
  let replacements = 0;
  const impossibleHash = Buffer.alloc(64).toString("base64");
  const invalidMetadata = validMetadata.replace(/^(\s*sha512: ).+$/gm, (_line, prefix) => {
    replacements += 1;
    return `${prefix}${impossibleHash}`;
  });
  assert.equal(replacements, 2, "checksum probe did not replace both metadata hashes");
  writeFileSync(path.join(directory, "latest-linux.yml"), invalidMetadata);
  return directory;
}

async function withAppImagePath(appImage, action) {
  const previous = process.env.APPIMAGE;
  process.env.APPIMAGE = appImage;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
  }
}

async function exerciseChecksumRejection({ root, currentPath, currentRelease, targetRelease, feedDirectory }) {
  const feed = await startFeed(feedDirectory, ["latest-linux.yml", targetRelease.appImageName]);
  const beforeHash = await fileHash(currentPath);
  try {
    return await withAppImagePath(currentPath, async () => {
      const { adapter } = createAppAdapter(root, "checksum-rejection", currentRelease.version, feed.url);
      const updater = createLoopbackUpdater(AppImageUpdater, adapter, feed.url);
      const failure = deferred();
      const messages = [];
      const lifecycle = [];
      let downloaded = false;
      updater.on("update-downloaded", () => {
        downloaded = true;
      });
      const controller = createDesktopUpdater({
        isPackaged: true,
        isWindowsStore: false,
        desktopVersion: currentRelease.version,
        shellVersion: require(path.join(ROOT, "node_modules/mirafold/package.json")).version,
        updateStrategy: "install",
        loadUpdater: async () => updater,
        showMessage: async (message) => {
          messages.push(message);
          if (message.title === "Mirafold update failed") failure.resolve(message);
          return { response: 0 };
        },
        prepareInstall: async () => {
          lifecycle.push("prepare");
          throw new Error("checksum rejection must happen before installation preparation");
        },
        recoverInstall: async () => {
          lifecycle.push("recover");
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      const checked = await controller.checkManually();
      assert.equal(checked?.isUpdateAvailable, true, "bad-checksum feed did not advertise the higher version");
      const failureMessage = await withTimeout(failure.promise, "checksum-rejection report");
      assert.match(failureMessage.message, /download the update/);
      assert.match(failureMessage.detail, /sha512 checksum mismatch/i);
      assert.equal(downloaded, false, "a checksum-mismatched payload emitted update-downloaded");
      assert.deepEqual(lifecycle, [], "checksum mismatch reached the install lifecycle");
      assert.equal(existsSync(currentPath), true, "checksum rejection removed the bridge AppImage");
      assert.equal(await fileHash(currentPath), beforeHash, "checksum rejection changed the bridge AppImage");
      assert.ok(feed.requests.some((request) => request.name === "latest-linux.yml"));
      assert.ok(feed.requests.some((request) => request.name === targetRelease.appImageName));
      return {
        advertisedVersion: targetRelease.version,
        payloadRequested: true,
        sha512MismatchReported: true,
        updateDownloadedEmitted: false,
        installLifecycleEntered: false,
        bridgeUnchanged: true,
      };
    });
  } finally {
    await feed.close();
  }
}

async function exerciseAppImageTransition({
  root,
  label,
  currentPath,
  currentRelease,
  targetRelease,
  deferFirst,
}) {
  const feed = await startFeed(targetRelease.directory, ["latest-linux.yml", targetRelease.appImageName]);
  const beforeHash = await fileHash(currentPath);
  try {
    return await withAppImagePath(currentPath, async () => {
      const { adapter } = createAppAdapter(root, label, currentRelease.version, feed.url);
      const updater = createLoopbackUpdater(AppImageUpdater, adapter, feed.url);
      let launch = null;
      updater.spawnLog = async (command, args, env) => {
        launch = { command, args, silentInstall: env?.APPIMAGE_SILENT_INSTALL };
        return true;
      };

      const daemonProbe = await startRealDaemon(root, label);
      const lifecycle = [];
      const messages = [];
      const installed = deferred();
      const firstReadyPrompt = deferred();
      let readyPrompts = 0;
      void installed.promise.catch(() => {});
      updater.quitAndInstall = (...args) => {
        try {
          lifecycle.push("install");
          assert.equal(daemonProbe.daemon.running, false, "AppImage install ran before daemon shutdown");
          installed.resolve({ args, result: updater.install(...args) });
        } catch (error) {
          installed.reject(error);
        }
      };
      updater.on("error", (error) => installed.reject(error));

      const controller = createDesktopUpdater({
        isPackaged: true,
        isWindowsStore: false,
        desktopVersion: currentRelease.version,
        shellVersion: require(path.join(ROOT, "node_modules/mirafold/package.json")).version,
        updateStrategy: "install",
        loadUpdater: async () => updater,
        showMessage: async (message) => {
          messages.push(message);
          if (message.title !== "Mirafold update ready") return { response: 0 };
          readyPrompts += 1;
          if (readyPrompts === 1) firstReadyPrompt.resolve();
          return { response: deferFirst && readyPrompts === 1 ? 1 : 0 };
        },
        prepareInstall: async () => {
          lifecycle.push("prepare");
          const clean = await daemonProbe.daemon.stop();
          assert.equal(clean, true, "daemon process tree shutdown was not proven");
          assert.equal(await localRequestSucceeds(daemonProbe.url), false, "daemon URL survived stop proof");
          lifecycle.push("stopped");
          return true;
        },
        recoverInstall: async () => {
          lifecycle.push("recover");
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      try {
        const checked = await controller.checkManually();
        assert.equal(checked?.isUpdateAvailable, true, `${label} did not discover ${targetRelease.version}`);
        await withTimeout(firstReadyPrompt.promise, `${label} downloaded-update prompt`);
        await flushEvents();
        await flushEvents();

        let deferredState = null;
        if (deferFirst) {
          const requestsBeforeRetry = feed.requests.length;
          const destination = path.join(path.dirname(currentPath), targetRelease.appImageName);
          assert.deepEqual(lifecycle, [], "choosing Later entered the install lifecycle");
          assert.equal(daemonProbe.daemon.running, true, "choosing Later stopped the daemon");
          assert.equal(await localRequestSucceeds(daemonProbe.url), true, "daemon stopped serving after Later");
          assert.equal(existsSync(currentPath), true, "choosing Later removed the current AppImage");
          assert.equal(await fileHash(currentPath), beforeHash, "choosing Later changed the current AppImage");
          assert.equal(existsSync(destination), false, "choosing Later installed the target AppImage");
          await controller.checkManually();
          assert.equal(
            feed.requests.length,
            requestsBeforeRetry,
            "retrying a deferred verified download contacted the feed again",
          );
          deferredState = {
            daemonStayedRunning: true,
            currentFileStayedUnchanged: true,
            cachedDownloadReused: true,
          };
        }

        const outcome = await withTimeout(installed.promise, `${label} installation`);
        assert.deepEqual(outcome.args, [false, true]);
        assert.equal(await outcome.result, true, `${label} platform updater refused the verified artifact`);
        assert.deepEqual(lifecycle, ["prepare", "stopped", "install"]);
        assert.equal(daemonProbe.crash, null, "intentional update shutdown was reported as a daemon crash");

        const destination = path.join(path.dirname(currentPath), targetRelease.appImageName);
        assert.equal(existsSync(currentPath), false, `${label} left the old AppImage name in place`);
        assert.equal(existsSync(destination), true, `${label} did not create the target AppImage`);
        assert.equal(await fileHash(destination), targetRelease.appImageHash, `${label} installed bytes differ`);
        assert.equal(launch?.command, destination, `${label} selected the wrong relaunch target`);
        assert.equal(launch?.silentInstall, "true");
        assert.equal(updater.allowDowngrade, false);
        return {
          installedPath: destination,
          report: {
            discoveredVersion: targetRelease.version,
            downloadedBytes: statSync(destination).size,
            deferredState,
            lifecycle,
            readyPrompts,
            installedHashVerified: true,
            relaunchTargetVerified: true,
          },
        };
      } finally {
        if (daemonProbe.daemon.running) await daemonProbe.daemon.stop();
      }
    });
  } finally {
    await feed.close();
  }
}

async function exerciseLowerVersionRefusal({ root, currentPath, currentRelease, lowerRelease }) {
  const feed = await startFeed(lowerRelease.directory, ["latest-linux.yml", lowerRelease.appImageName]);
  const beforeHash = await fileHash(currentPath);
  try {
    return await withAppImagePath(currentPath, async () => {
      const { adapter } = createAppAdapter(root, "lower-version-refusal", currentRelease.version, feed.url);
      const updater = createLoopbackUpdater(AppImageUpdater, adapter, feed.url);
      const lifecycle = [];
      const messages = [];
      const controller = createDesktopUpdater({
        isPackaged: true,
        isWindowsStore: false,
        desktopVersion: currentRelease.version,
        shellVersion: require(path.join(ROOT, "node_modules/mirafold/package.json")).version,
        updateStrategy: "install",
        loadUpdater: async () => updater,
        showMessage: async (message) => {
          messages.push(message);
          return { response: 0 };
        },
        prepareInstall: async () => {
          lifecycle.push("prepare");
          return true;
        },
        recoverInstall: async () => {
          lifecycle.push("recover");
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      const checked = await controller.checkManually();
      assert.equal(checked?.isUpdateAvailable, false, "lower Desktop version was accepted as a rollback");
      assert.equal(updater.allowDowngrade, false);
      assert.deepEqual(lifecycle, []);
      assert.equal(await fileHash(currentPath), beforeHash, "lower-version check changed the current AppImage");
      assert.ok(messages.some((message) => message.title === "Mirafold is up to date"));
      assert.equal(
        feed.requests.some((request) => request.name === lowerRelease.appImageName),
        false,
        "lower-version check downloaded the older payload",
      );
      return {
        currentVersion: currentRelease.version,
        refusedVersion: lowerRelease.version,
        allowDowngrade: false,
        payloadRequested: false,
        installLifecycleEntered: false,
      };
    });
  } finally {
    await feed.close();
  }
}

async function exerciseBridgeBoundary(args) {
  if (args.length !== 3) {
    throw new Error("usage: linux-update-probe.mjs --bridge BRIDGE_DIR REGRESSED_DIR RECOVERY_DIR");
  }
  const [bridgeDirectory, regressedDirectory, recoveryDirectory] = args.map((value) => path.resolve(value));
  const bridge = await readBridgeProbeRelease(bridgeDirectory, "0.1.2", "known-good");
  const regressed = await readBridgeProbeRelease(regressedDirectory, "0.1.3", "simulated-regression");
  const recovery = await readBridgeProbeRelease(recoveryDirectory, "0.1.4", "known-good");
  assert.equal(bridge.state, recovery.state, "higher recovery did not restore the bridge payload marker");
  assert.notEqual(regressed.state, recovery.state, "recovery payload is not distinguishable from regression payload");
  assert.equal(bridge.updaterHash, regressed.updaterHash, "probe marker unexpectedly changed updater source");
  assert.equal(bridge.updaterHash, recovery.updaterHash, "recovery did not preserve updater source");
  assert.equal(
    bridge.updaterHash,
    await fileHash(path.join(ROOT, "src", "updater.js")),
    "bridge candidates do not carry the checkout's updater source",
  );
  const bridgeIdentity = runPackagedIdentityProbe(bridge);
  const regressedIdentity = runPackagedIdentityProbe(regressed);
  const recoveryIdentity = runPackagedIdentityProbe(recovery);

  // builder-util's Node transport consults lowercase proxy variables without
  // NO_PROXY handling. Keep every update byte on the loopback servers below.
  delete process.env.http_proxy;
  delete process.env.https_proxy;

  const root = mkdtempSync(path.join(tmpdir(), "mirafold-bridge-update-probe-"));
  try {
    const installedDirectory = path.join(root, "installed");
    mkdirSync(installedDirectory, { recursive: true });
    const bridgePath = path.join(installedDirectory, bridge.appImageName);
    copyFileSync(bridge.appImage, bridgePath);
    chmodSync(bridgePath, statSync(bridge.appImage).mode);
    assert.equal(await fileHash(bridgePath), bridge.appImageHash, "manual bridge placement changed the AppImage");

    const badChecksumDirectory = createBadChecksumFeed(root, regressed);
    const checksumRejection = await exerciseChecksumRejection({
      root,
      currentPath: bridgePath,
      currentRelease: bridge,
      targetRelease: regressed,
      feedDirectory: badChecksumDirectory,
    });
    const firstTransition = await exerciseAppImageTransition({
      root,
      label: "bridge-to-regressed",
      currentPath: bridgePath,
      currentRelease: bridge,
      targetRelease: regressed,
      deferFirst: true,
    });
    const lowerVersionRefusal = await exerciseLowerVersionRefusal({
      root,
      currentPath: firstTransition.installedPath,
      currentRelease: regressed,
      lowerRelease: bridge,
    });
    const recoveryTransition = await exerciseAppImageTransition({
      root,
      label: "regressed-to-recovery",
      currentPath: firstTransition.installedPath,
      currentRelease: regressed,
      targetRelease: recovery,
      deferFirst: false,
    });
    assert.equal(await fileHash(recoveryTransition.installedPath), recovery.appImageHash);

    process.stdout.write(`${JSON.stringify({
      updateFeedLoopbackOnly: true,
      manualBridgeInstall: {
        version: bridge.version,
        payloadState: bridge.state,
        copiedIntoUserWritableDirectory: true,
        bytes: statSync(bridge.appImage).size,
      },
      checksumRejection,
      firstTransition: firstTransition.report,
      restartBoundary: {
        relaunchTargetVersion: regressed.version,
        freshControllerCurrentVersion: regressed.version,
        packagedExecutableIdentity: regressedIdentity,
      },
      lowerVersionRefusal,
      recoveryTransition: recoveryTransition.report,
      finalState: {
        version: recovery.version,
        payloadState: recovery.state,
        restoredBridgePayloadState: recovery.state === bridge.state,
        updaterSourceMatchesBridge: recovery.updaterHash === bridge.updaterHash,
        packagedExecutableIdentity: recoveryIdentity,
        bridgeExecutableIdentity: bridgeIdentity,
      },
    }, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args[0] === "--bridge") return exerciseBridgeBoundary(args.slice(1));
  if (args.length !== 2) {
    throw new Error(
      "usage: linux-update-probe.mjs OLD_APPIMAGE NEW_RELEASE_DIRECTORY | --bridge BRIDGE_DIR REGRESSED_DIR RECOVERY_DIR",
    );
  }
  const oldAppImage = path.resolve(args[0]);
  const feedDirectory = path.resolve(args[1]);
  const oldMatch = path.basename(oldAppImage).match(/-(\d+\.\d+\.\d+)\.AppImage$/);
  invariant(oldMatch, `cannot read old version from ${path.basename(oldAppImage)}`);
  const oldVersion = oldMatch[1];
  const metadata = parseUpdateMetadata(readFileSync(path.join(feedDirectory, "latest-linux.yml"), "utf8"));
  const newVersion = metadata.version;
  invariant(oldVersion !== newVersion, "probe needs two different packaged versions");
  await verifyPlatformArtifacts(feedDirectory, newVersion, "linux");

  // builder-util's Node transport consults lowercase proxy variables without
  // NO_PROXY handling. Remove them in this disposable process so every byte is
  // demonstrably served by the loopback server below.
  delete process.env.http_proxy;
  delete process.env.https_proxy;

  const root = mkdtempSync(path.join(tmpdir(), "mirafold-linux-update-probe-"));
  const allowedNames = [
    "latest-linux.yml",
    `Mirafold-${newVersion}.AppImage`,
    `mirafold-desktop_${newVersion}_amd64.deb`,
    `mirafold-desktop-${newVersion}.tar.gz`,
  ];
  let feed = null;
  try {
    feed = await startFeed(feedDirectory, allowedNames);
    const appImage = await exerciseAppImage({ root, oldAppImage, feedDirectory, feedUrl: feed.url, oldVersion, newVersion });
    const deb = await exerciseDeb({ root, feedDirectory, feedUrl: feed.url, oldVersion, newVersion });
    const tar = await exerciseTarNotice({ root, feedUrl: feed.url, oldVersion, requests: feed.requests });
    process.stdout.write(`${JSON.stringify({ oldVersion, newVersion, updateFeedLoopbackOnly: true, appImage, deb, tar }, null, 2)}\n`);
  } finally {
    if (feed) await feed.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Linux update probe failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
