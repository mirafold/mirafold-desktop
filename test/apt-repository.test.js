import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APT_MANAGED_MARKER,
  APT_SOURCES_FILE,
  ARCHIVE_KEYRING_DEB,
  ARCHIVE_KEYRING_FILE,
  aptSources,
  assembleAptRepository,
  buildAptRepository,
  expectedAptAssets,
  publicKeyFingerprint,
  verifyAptRepository,
} from "../scripts/apt-repository.mjs";
import { APT_MANAGED_MARKER as RUNTIME_APT_MANAGED_MARKER } from "../src/updater.js";

const REQUIRED_TOOLS = ["apt-cache", "apt-get", "dpkg-deb", "gpg", "gpgv"];
const DESKTOP_VERSION = "1.2.3";
const FIXED_DATE = "2026-08-26T12:00:00Z";

test("repository sources require HTTPS except for the IPv4-loopback test seam", () => {
  assert.match(aptSources("https://example.com/mirafold"), /URIs: https:\/\/example\.com\/mirafold\//);
  assert.match(aptSources("http://127.0.0.1:8080"), /URIs: http:\/\/127\.0\.0\.1:8080\//);
  assert.throws(
    () => aptSources("http://example.com/mirafold"),
    /must use HTTPS outside an IPv4-loopback test/,
  );
  assert.throws(
    () => aptSources("ftp://127.0.0.1/mirafold"),
    /must use HTTPS outside an IPv4-loopback test/,
  );
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new Error(`${command} failed (${code}):\n${errors || output}`));
    });
  });
}

function toolAvailable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true });
  return !result.error && result.status === 0;
}

function createDesktopPackage(root) {
  const packageRoot = path.join(root, "desktop-package");
  const control = path.join(packageRoot, "DEBIAN");
  const binary = path.join(packageRoot, "usr", "bin");
  mkdirSync(control, { recursive: true });
  mkdirSync(binary, { recursive: true });
  writeFileSync(
    path.join(control, "control"),
    [
      "Package: mirafold-desktop",
      `Version: ${DESKTOP_VERSION}`,
      "Architecture: amd64",
      "Section: devel",
      "Priority: optional",
      "Maintainer: Mirafold Test <test@mirafold.invalid>",
      "Description: Minimal Mirafold Desktop APT contract fixture",
      " Exercises repository metadata without packaging the real application.",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(binary, "mirafold"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const output = path.join(root, `mirafold-desktop_${DESKTOP_VERSION}_amd64.deb`);
  run("dpkg-deb", ["--build", "--root-owner-group", packageRoot, output]);
  return output;
}

function createSigningKey(root) {
  const home = path.join(root, "gnupg");
  const publicKey = path.join(root, ARCHIVE_KEYRING_FILE);
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  run("gpg", [
    "--batch",
    "--homedir",
    home,
    "--passphrase",
    "",
    "--quick-generate-key",
    "Mirafold APT Test <apt-test@mirafold.invalid>",
    "rsa2048",
    "sign",
    "1d",
  ]);
  const listing = run("gpg", ["--batch", "--homedir", home, "--with-colons", "--fingerprint", "--list-secret-keys"]);
  const fingerprint = listing
    .split("\n")
    .find((line) => line.startsWith("fpr:"))
    ?.split(":")[9];
  assert.match(fingerprint, /^[A-F0-9]{40}$/);
  run("gpg", ["--batch", "--homedir", home, "--output", publicKey, "--export", fingerprint]);
  assert.equal(publicKeyFingerprint(publicKey), fingerprint);
  return { home, publicKey, fingerprint };
}

async function assembleWithHome(options, key) {
  const prior = process.env.GNUPGHOME;
  process.env.GNUPGHOME = key.home;
  try {
    return await assembleAptRepository(options);
  } finally {
    if (prior === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = prior;
  }
}

function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isolatedAptOptions(root, sources) {
  const lists = path.join(root, "state", "lists");
  const archives = path.join(root, "cache", "archives");
  const status = path.join(root, "state", "status");
  mkdirSync(path.join(lists, "partial"), { recursive: true });
  mkdirSync(path.join(archives, "partial"), { recursive: true });
  writeFileSync(status, "");
  return [
    "-o", "Debug::NoLocking=1",
    "-o", `Dir::Etc::sourcelist=${sources}`,
    "-o", "Dir::Etc::sourceparts=-",
    "-o", "Dir::Etc::trusted=-",
    "-o", "Dir::Etc::trustedparts=-",
    "-o", `Dir::State::lists=${lists}`,
    "-o", `Dir::State::status=${status}`,
    "-o", `Dir::Cache::archives=${archives}`,
    "-o", "APT::Architecture=amd64",
    "-o", "Acquire::Languages=none",
    "-o", "Acquire::AllowInsecureRepositories=false",
    "-o", "Acquire::AllowDowngradeToInsecureRepositories=false",
    "-o", "APT::Get::List-Cleanup=0",
  ];
}

test("the signed flat repository survives tampering checks and a redirected APT download", {
  skip: process.platform !== "linux" || REQUIRED_TOOLS.some((tool) => !toolAvailable(tool)),
  timeout: 60_000,
}, async () => {
  assert.equal(APT_MANAGED_MARKER, RUNTIME_APT_MANAGED_MARKER);
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-apt-test-"));
  const repository = path.join(root, "repository");
  const requestedPaths = [];
  const originPaths = [];
  mkdirSync(repository);
  let origin;
  let redirect;

  try {
    origin = http.createServer((request, response) => {
      originPaths.push(request.url);
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const name = pathname.slice(1);
      if (!name || name !== path.basename(name)) {
        response.writeHead(404).end();
        return;
      }
      const file = path.join(repository, name);
      if (!existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Length": readFileSync(file).length });
      createReadStream(file).pipe(response);
    });
    const originPort = await listen(origin);
    redirect = http.createServer((request, response) => {
      requestedPaths.push(request.url);
      response.writeHead(302, { Location: `http://127.0.0.1:${originPort}${request.url}` }).end();
    });
    const redirectPort = await listen(redirect);
    const repositoryUri = `http://127.0.0.1:${redirectPort}/`;

    const desktopDeb = createDesktopPackage(root);
    const key = createSigningKey(root);
    const fingerprintFile = path.join(root, "fingerprint.txt");
    writeFileSync(fingerprintFile, `${key.fingerprint}\n`);
    const built = await assembleWithHome({
      directory: repository,
      desktopDeb,
      publicKey: key.publicKey,
      fingerprintFile,
      repositoryUri,
      date: FIXED_DATE,
    }, key);
    assert.equal(built.desktopVersion, DESKTOP_VERSION);
    assert.equal(built.fingerprint, key.fingerprint);
    assert.deepEqual(built.assets, expectedAptAssets());
    assert.deepEqual(
      readdirSync(repository).filter((name) => expectedAptAssets().includes(name)).sort(),
      expectedAptAssets(),
    );

    const reproduced = path.join(root, "reproduced");
    mkdirSync(reproduced);
    await buildAptRepository({
      outputDirectory: reproduced,
      desktopDeb,
      publicKey: key.publicKey,
      repositoryUri,
      date: FIXED_DATE,
    });
    for (const name of expectedAptAssets({ signed: false })) {
      assert.ok(
        readFileSync(path.join(reproduced, name)).equals(readFileSync(path.join(repository, name))),
        `${name} was not reproducible`,
      );
    }
    await verifyAptRepository({
      directory: repository,
      desktopVersion: DESKTOP_VERSION,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      repositoryUri,
    });

    const packageTamper = path.join(root, "package-tamper");
    cpSync(repository, packageTamper, { recursive: true });
    appendFileSync(path.join(packageTamper, `mirafold-desktop_${DESKTOP_VERSION}_amd64.deb`), "tamper");
    await assert.rejects(
      verifyAptRepository({
        directory: packageTamper,
        desktopVersion: DESKTOP_VERSION,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        repositoryUri,
      }),
      /Packages mirafold-desktop (?:size|SHA256) differs/,
    );

    const indexTamper = path.join(root, "index-tamper");
    cpSync(repository, indexTamper, { recursive: true });
    appendFileSync(path.join(indexTamper, "Packages"), "\n");
    await assert.rejects(
      verifyAptRepository({
        directory: indexTamper,
        desktopVersion: DESKTOP_VERSION,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        repositoryUri,
      }),
      /Packages\.gz does not contain Packages/,
    );

    const aptRoot = path.join(root, "apt-client");
    const sources = path.join(root, APT_SOURCES_FILE);
    mkdirSync(aptRoot);
    writeFileSync(
      sources,
      aptSources(repositoryUri).replace(
        `/usr/share/keyrings/${ARCHIVE_KEYRING_FILE}`,
        key.publicKey,
      ),
    );
    const options = isolatedAptOptions(aptRoot, sources);
    await runAsync("apt-get", [...options, "update"]);
    const policy = await runAsync("apt-cache", [...options, "policy", "mirafold-desktop"]);
    assert.match(policy, /Candidate: 1\.2\.3/);

    const downloads = path.join(root, "downloads");
    mkdirSync(downloads);
    await runAsync("apt-get", [...options, "download", "mirafold-desktop"], { cwd: downloads });
    const downloaded = path.join(downloads, `mirafold-desktop_${DESKTOP_VERSION}_amd64.deb`);
    assert.equal(await digest(downloaded), await digest(path.join(repository, path.basename(downloaded))));
    const requestLog = JSON.stringify({ redirects: requestedPaths, origin: originPaths });
    assert.ok(
      requestedPaths.includes("/./InRelease"),
      `APT did not request signed InRelease through the redirect; requests: ${requestLog}`,
    );
    assert.ok(
      originPaths.includes("/./Packages.gz"),
      `APT did not request the signed package index from the redirected origin; requests: ${requestLog}`,
    );
    assert.ok(
      requestedPaths.some((value) => value.endsWith(path.basename(downloaded))),
      `APT did not request the package through the redirect; requests: ${requestLog}`,
    );

    const keyringContents = run("dpkg-deb", ["-c", path.join(repository, ARCHIVE_KEYRING_DEB)]);
    assert.match(keyringContents, /usr\/share\/keyrings\/mirafold-archive-keyring\.gpg/);
    assert.match(keyringContents, /etc\/apt\/sources\.list\.d\/mirafold\.sources/);
    assert.match(keyringContents, /usr\/share\/mirafold\/apt-managed/);
  } finally {
    if (redirect?.listening) await close(redirect);
    if (origin?.listening) await close(origin);
    rmSync(root, { recursive: true, force: true });
  }
});
