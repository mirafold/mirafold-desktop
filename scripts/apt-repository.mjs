// Build and verify the signed flat APT repository attached to every stable
// Mirafold Desktop GitHub Release.
//
// This file deliberately has no package imports. Debian's own dpkg tooling
// owns .deb semantics, GnuPG owns OpenPGP, and Node's standard library owns
// the small deterministic metadata layer around them. Release writers can run
// it without installing dependency code beside their signing credential.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

export const APT_REPOSITORY_URI =
  "https://github.com/mirafold/mirafold-desktop/releases/latest/download/";
export const APT_MANAGED_MARKER = "/usr/share/mirafold/apt-managed";
export const ARCHIVE_KEYRING_PACKAGE = "mirafold-archive-keyring";
export const ARCHIVE_KEYRING_VERSION = "1.0";
export const ARCHIVE_KEYRING_DEB =
  `${ARCHIVE_KEYRING_PACKAGE}_${ARCHIVE_KEYRING_VERSION}_all.deb`;
export const ARCHIVE_KEYRING_FILE = "mirafold-archive-keyring.gpg";
export const APT_SOURCES_FILE = "mirafold.sources";

// Public-key creation time for archive-keyring version 1.0. dpkg-deb uses
// SOURCE_DATE_EPOCH for both its ar header and tar mtime clamp, so the bootstrap
// package remains byte-identical across Desktop releases until a deliberate
// keyring content/version change advances this value.
const ARCHIVE_KEYRING_SOURCE_DATE_EPOCH = "1787802771";

const DESKTOP_PACKAGE = "mirafold-desktop";
const ARCHITECTURE = "amd64";
const FINGERPRINT = /^[A-F0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const APT_UNSIGNED_ASSETS = [
  "Packages",
  "Packages.gz",
  "Release",
  ARCHIVE_KEYRING_DEB,
  ARCHIVE_KEYRING_FILE,
  APT_SOURCES_FILE,
].sort();
const APT_SIGNATURE_ASSETS = ["InRelease", "Release.gpg"].sort();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeLf(value) {
  return String(value).replace(/\r\n/g, "\n");
}

function regularFile(file, label = path.basename(file)) {
  const record = lstatSync(file);
  invariant(record.isFile(), `${label} must be a regular file`);
  return record;
}

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
  invariant(
    result.status === 0,
    `${command} failed (${result.status}): ${normalizeLf(result.stderr || result.stdout).trim()}`,
  );
  return normalizeLf(result.stdout);
}

function withTempDirectory(prefix, callback) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeExclusive(file, contents, mode = 0o644) {
  writeFileSync(file, contents, { flag: "wx", mode });
}

function canonicalRepositoryUri(value) {
  const uri = new URL(value);
  invariant(
    uri.protocol === "https:" || (uri.protocol === "http:" && uri.hostname === "127.0.0.1"),
    "APT repository URI must use HTTPS outside an IPv4-loopback test",
  );
  invariant(uri.username === "" && uri.password === "" && uri.search === "" && uri.hash === "", "APT repository URI must not contain credentials, query, or fragment");
  if (!uri.pathname.endsWith("/")) uri.pathname += "/";
  return uri.href;
}

export function aptSources(repositoryUri = APT_REPOSITORY_URI) {
  const uri = canonicalRepositoryUri(repositoryUri);
  return [
    "Types: deb",
    `URIs: ${uri}`,
    "Suites: ./",
    `Architectures: ${ARCHITECTURE}`,
    `Signed-By: /usr/share/keyrings/${ARCHIVE_KEYRING_FILE}`,
    "",
  ].join("\n");
}

function aptMarker(repositoryUri = APT_REPOSITORY_URI) {
  return [
    `managed-by: ${ARCHIVE_KEYRING_PACKAGE}`,
    `repository: ${canonicalRepositoryUri(repositoryUri)}`,
    "",
  ].join("\n");
}

function parseDeb822Stanza(text, label) {
  const fields = new Map();
  let current = null;
  for (const [index, line] of normalizeLf(text).split("\n").entries()) {
    if (line === "") continue;
    const field = line.match(/^([A-Za-z0-9][A-Za-z0-9-]*):(?: (.*))?$/);
    if (field) {
      const [, name, value = ""] = field;
      invariant(!fields.has(name), `${label} repeats field ${name}`);
      fields.set(name, value);
      current = name;
      continue;
    }
    invariant(current !== null && /^[ \t]/.test(line), `${label} has invalid control syntax on line ${index + 1}`);
    fields.set(current, `${fields.get(current)}\n${line}`);
  }
  return fields;
}

function parseDeb822Paragraphs(text, label) {
  return normalizeLf(text)
    .trim()
    .split(/\n{2,}/)
    .map((paragraph, index) => parseDeb822Stanza(paragraph, `${label} paragraph ${index + 1}`));
}

function debControl(file) {
  regularFile(file, path.basename(file));
  const text = run("dpkg-deb", ["-f", file]);
  const fields = parseDeb822Stanza(text, path.basename(file));
  for (const required of ["Package", "Version", "Architecture", "Description"]) {
    invariant(fields.get(required), `${path.basename(file)} has no ${required} field`);
  }
  for (const reserved of ["Filename", "Size", "SHA256", "SHA512"]) {
    invariant(!fields.has(reserved), `${path.basename(file)} control data contains reserved field ${reserved}`);
  }
  return { text: `${normalizeLf(text).trimEnd()}\n`, fields };
}

function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function packageParagraph(file) {
  const control = debControl(file);
  return {
    package: control.fields.get("Package"),
    text: [
      control.text.trimEnd(),
      `Filename: ${path.basename(file)}`,
      `Size: ${statSync(file).size}`,
      `SHA256: ${await hashFile(file, "sha256")}`,
      `SHA512: ${await hashFile(file, "sha512")}`,
      "",
    ].join("\n"),
  };
}

function publicKeyFingerprints(publicKey) {
  return withTempDirectory("mirafold-apt-key-inspect-", (home) => {
    chmodSync(home, 0o700);
    const listing = run(
      "gpg",
      ["--batch", "--no-options", "--homedir", home, "--with-colons", "--import-options", "show-only", "--import", publicKey],
    );
    return listing
      .split("\n")
      .filter((line) => line.startsWith("fpr:"))
      .map((line) => line.split(":")[9]);
  });
}

export function publicKeyFingerprint(publicKey) {
  regularFile(publicKey, ARCHIVE_KEYRING_FILE);
  const fingerprints = publicKeyFingerprints(publicKey);
  invariant(fingerprints.length > 0 && FINGERPRINT.test(fingerprints[0]), "APT public key has no canonical primary fingerprint");
  return fingerprints[0];
}

function buildArchiveKeyringPackage({ outputDirectory, publicKey, repositoryUri }) {
  const output = path.join(outputDirectory, ARCHIVE_KEYRING_DEB);
  invariant(!existsSync(output), `${ARCHIVE_KEYRING_DEB} already exists`);

  withTempDirectory("mirafold-archive-keyring-", (root) => {
    const controlDirectory = path.join(root, "DEBIAN");
    const keyDirectory = path.join(root, "usr", "share", "keyrings");
    const sourceDirectory = path.join(root, "etc", "apt", "sources.list.d");
    const markerDirectory = path.join(root, "usr", "share", "mirafold");
    const docsDirectory = path.join(root, "usr", "share", "doc", ARCHIVE_KEYRING_PACKAGE);
    for (const directory of [controlDirectory, keyDirectory, sourceDirectory, markerDirectory, docsDirectory]) {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
    }

    copyFileSync(publicKey, path.join(keyDirectory, ARCHIVE_KEYRING_FILE), fsConstants.COPYFILE_EXCL);
    writeExclusive(path.join(sourceDirectory, APT_SOURCES_FILE), aptSources(repositoryUri));
    writeExclusive(path.join(markerDirectory, "apt-managed"), aptMarker(repositoryUri));
    writeExclusive(
      path.join(docsDirectory, "copyright"),
      [
        "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/",
        "Upstream-Name: Mirafold APT archive configuration",
        "Source: https://github.com/mirafold/mirafold-desktop",
        "",
        "Files: *",
        "Copyright: 2026 Kyle Serrecchia",
        "License: MIT",
        "",
      ].join("\n"),
    );
    writeExclusive(
      path.join(controlDirectory, "control"),
      [
        `Package: ${ARCHIVE_KEYRING_PACKAGE}`,
        `Version: ${ARCHIVE_KEYRING_VERSION}`,
        "Architecture: all",
        "Section: misc",
        "Priority: optional",
        "Maintainer: Kyle Serrecchia <security@mirafold.com>",
        "Description: Mirafold APT repository configuration and signing key",
        " Installs the public archive key and source definition used by APT to",
        " authenticate and retrieve Mirafold Desktop releases.",
        "",
      ].join("\n"),
    );
    run("dpkg-deb", ["--build", "--root-owner-group", root, output], {
      env: { ...process.env, SOURCE_DATE_EPOCH: ARCHIVE_KEYRING_SOURCE_DATE_EPOCH },
    });
  });

  regularFile(output, ARCHIVE_KEYRING_DEB);
  return output;
}

function releaseDate(value) {
  const date = value === undefined ? new Date() : new Date(value);
  invariant(!Number.isNaN(date.valueOf()), "APT Release date is invalid");
  return date.toUTCString();
}

async function releaseChecksums(directory, names, algorithm) {
  const lines = [];
  for (const name of names) {
    const file = path.join(directory, name);
    lines.push(` ${await hashFile(file, algorithm)} ${statSync(file).size.toString().padStart(16)} ${name}`);
  }
  return lines;
}

export function expectedAptAssets({ signed = true } = {}) {
  return [...APT_UNSIGNED_ASSETS, ...(signed ? APT_SIGNATURE_ASSETS : [])].sort();
}

export async function buildAptRepository({
  outputDirectory,
  desktopDeb,
  publicKey,
  repositoryUri = APT_REPOSITORY_URI,
  date,
}) {
  const output = path.resolve(outputDirectory);
  const desktopSource = path.resolve(desktopDeb);
  const keySource = path.resolve(publicKey);
  invariant(existsSync(output) && lstatSync(output).isDirectory(), "APT output directory does not exist");
  for (const name of expectedAptAssets()) {
    invariant(!existsSync(path.join(output, name)), `APT asset ${name} already exists`);
  }

  const desktop = debControl(desktopSource);
  invariant(desktop.fields.get("Package") === DESKTOP_PACKAGE, `Desktop Debian package is ${desktop.fields.get("Package")}, expected ${DESKTOP_PACKAGE}`);
  invariant(VERSION.test(desktop.fields.get("Version")), "Desktop Debian package version is not stable X.Y.Z");
  invariant(desktop.fields.get("Architecture") === ARCHITECTURE, `Desktop Debian architecture is ${desktop.fields.get("Architecture")}, expected ${ARCHITECTURE}`);
  publicKeyFingerprint(keySource);

  const desktopTarget = path.join(output, path.basename(desktopSource));
  if (desktopTarget !== desktopSource) copyFileSync(desktopSource, desktopTarget, fsConstants.COPYFILE_EXCL);
  copyFileSync(keySource, path.join(output, ARCHIVE_KEYRING_FILE), fsConstants.COPYFILE_EXCL);
  writeExclusive(path.join(output, APT_SOURCES_FILE), aptSources(repositoryUri));
  const keyringDeb = buildArchiveKeyringPackage({ outputDirectory: output, publicKey: keySource, repositoryUri });

  const paragraphs = await Promise.all([desktopTarget, keyringDeb].map(packageParagraph));
  paragraphs.sort((left, right) => left.package.localeCompare(right.package));
  const packages = paragraphs.map(({ text }) => text).join("\n");
  writeExclusive(path.join(output, "Packages"), packages);
  writeExclusive(path.join(output, "Packages.gz"), gzipSync(Buffer.from(packages), { level: 9, mtime: 0 }));

  const indices = ["Packages", "Packages.gz"];
  const sha256 = await releaseChecksums(output, indices, "sha256");
  const sha512 = await releaseChecksums(output, indices, "sha512");
  writeExclusive(
    path.join(output, "Release"),
    [
      "Origin: Mirafold",
      "Label: Mirafold Desktop",
      "Suite: stable",
      "Codename: stable",
      `Architectures: ${ARCHITECTURE}`,
      `Date: ${releaseDate(date)}`,
      "Description: Signed Mirafold Desktop packages",
      "SHA256:",
      ...sha256,
      "SHA512:",
      ...sha512,
      "",
    ].join("\n"),
  );

  return {
    desktopVersion: desktop.fields.get("Version"),
    fingerprint: publicKeyFingerprint(keySource),
    assets: expectedAptAssets({ signed: false }),
  };
}

function secretKeyFingerprint(expected) {
  invariant(FINGERPRINT.test(expected), "APT signing fingerprint must be 40 uppercase hexadecimal characters");
  const listing = run("gpg", ["--batch", "--with-colons", "--fingerprint", "--list-secret-keys", expected]);
  const fingerprints = listing
    .split("\n")
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]);
  invariant(fingerprints[0] === expected, "loaded APT secret key fingerprint differs");
  return expected;
}

export function signAptRepository(directory, fingerprint) {
  const root = path.resolve(directory);
  regularFile(path.join(root, "Release"), "Release");
  invariant(!existsSync(path.join(root, "InRelease")), "InRelease already exists");
  invariant(!existsSync(path.join(root, "Release.gpg")), "Release.gpg already exists");
  secretKeyFingerprint(fingerprint);
  const common = ["--batch", "--no-tty", "--pinentry-mode", "loopback", "--local-user", fingerprint, "--digest-algo", "SHA256"];
  run("gpg", [...common, "--output", path.join(root, "InRelease"), "--clearsign", path.join(root, "Release")]);
  run("gpg", [...common, "--armor", "--output", path.join(root, "Release.gpg"), "--detach-sign", path.join(root, "Release")]);
  return expectedAptAssets();
}

function parseReleaseHashes(release, field) {
  const value = release.get(field);
  invariant(value !== undefined, `Release has no ${field} field`);
  const rows = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  invariant(rows.every((row) => row.length === 3), `Release ${field} field is malformed`);
  return new Map(rows.map(([digest, size, name]) => [name, { digest, size: Number(size) }]));
}

async function verifyReleaseFile(directory) {
  const release = parseDeb822Stanza(readFileSync(path.join(directory, "Release"), "utf8"), "Release");
  const expected = new Map([
    ["Origin", "Mirafold"],
    ["Label", "Mirafold Desktop"],
    ["Suite", "stable"],
    ["Codename", "stable"],
    ["Architectures", ARCHITECTURE],
    ["Description", "Signed Mirafold Desktop packages"],
  ]);
  for (const [field, value] of expected) invariant(release.get(field) === value, `Release ${field} differs`);
  invariant(!Number.isNaN(Date.parse(release.get("Date"))), "Release Date is invalid");
  for (const algorithm of ["sha256", "sha512"]) {
    const rows = parseReleaseHashes(release, algorithm.toUpperCase());
    invariant(JSON.stringify([...rows.keys()].sort()) === JSON.stringify(["Packages", "Packages.gz"]), `Release ${algorithm.toUpperCase()} index set differs`);
    for (const [name, record] of rows) {
      const file = path.join(directory, name);
      invariant(record.size === statSync(file).size, `Release ${name} size differs`);
      invariant(record.digest === await hashFile(file, algorithm), `Release ${name} ${algorithm.toUpperCase()} differs`);
    }
  }
}

async function verifyPackageIndex(directory, desktopVersion) {
  const packages = readFileSync(path.join(directory, "Packages"), "utf8");
  invariant(gunzipSync(readFileSync(path.join(directory, "Packages.gz"))).toString("utf8") === packages, "Packages.gz does not contain Packages");
  const paragraphs = parseDeb822Paragraphs(packages, "Packages");
  const byName = new Map(paragraphs.map((fields) => [fields.get("Package"), fields]));
  invariant(paragraphs.length === 2 && byName.size === 2, "Packages must describe exactly two unique packages");
  const expected = new Map([
    [DESKTOP_PACKAGE, { version: desktopVersion, architecture: ARCHITECTURE }],
    [ARCHIVE_KEYRING_PACKAGE, { version: ARCHIVE_KEYRING_VERSION, architecture: "all" }],
  ]);
  for (const [name, identity] of expected) {
    const fields = byName.get(name);
    invariant(fields, `Packages omits ${name}`);
    invariant(fields.get("Version") === identity.version, `Packages ${name} version differs`);
    invariant(fields.get("Architecture") === identity.architecture, `Packages ${name} architecture differs`);
    const filename = fields.get("Filename");
    invariant(filename === path.basename(filename) && filename.endsWith(".deb"), `Packages ${name} filename is not repository-root relative`);
    const file = path.join(directory, filename);
    regularFile(file, filename);
    invariant(Number(fields.get("Size")) === statSync(file).size, `Packages ${name} size differs`);
    invariant(fields.get("SHA256") === await hashFile(file, "sha256"), `Packages ${name} SHA256 differs`);
    invariant(fields.get("SHA512") === await hashFile(file, "sha512"), `Packages ${name} SHA512 differs`);
  }
}

function verifyArchiveKeyringPackage(directory, publicKey, repositoryUri) {
  const deb = path.join(directory, ARCHIVE_KEYRING_DEB);
  const control = debControl(deb).fields;
  invariant(control.get("Package") === ARCHIVE_KEYRING_PACKAGE, "archive-keyring package name differs");
  invariant(control.get("Version") === ARCHIVE_KEYRING_VERSION, "archive-keyring package version differs");
  invariant(control.get("Architecture") === "all", "archive-keyring package architecture differs");
  withTempDirectory("mirafold-archive-keyring-verify-", (root) => {
    run("dpkg-deb", ["-x", deb, root]);
    const packagedKey = path.join(root, "usr", "share", "keyrings", ARCHIVE_KEYRING_FILE);
    const packagedSources = path.join(root, "etc", "apt", "sources.list.d", APT_SOURCES_FILE);
    const packagedMarker = path.join(root, APT_MANAGED_MARKER.slice(1));
    invariant(readFileSync(packagedKey).equals(readFileSync(publicKey)), "archive-keyring package public key differs");
    invariant(readFileSync(packagedSources, "utf8") === aptSources(repositoryUri), "archive-keyring package source definition differs");
    invariant(readFileSync(packagedMarker, "utf8") === aptMarker(repositoryUri), "archive-keyring package management marker differs");
  });
}

function verifySignatures(directory, publicKey) {
  return withTempDirectory("mirafold-apt-signature-", (temporary) => {
    const extracted = path.join(temporary, "Release");
    run("gpgv", ["--keyring", publicKey, "--output", extracted, path.join(directory, "InRelease")]);
    invariant(readFileSync(extracted, "utf8") === readFileSync(path.join(directory, "Release"), "utf8"), "InRelease signed text differs from Release");
    run("gpgv", ["--keyring", publicKey, path.join(directory, "Release.gpg"), path.join(directory, "Release")]);
  });
}

export async function verifyAptRepository({
  directory,
  desktopVersion,
  publicKey,
  fingerprint,
  repositoryUri = APT_REPOSITORY_URI,
}) {
  const root = path.resolve(directory);
  invariant(VERSION.test(desktopVersion), "expected Desktop version is not stable X.Y.Z");
  const expectedFingerprint = publicKeyFingerprint(publicKey);
  invariant(FINGERPRINT.test(fingerprint) && fingerprint === expectedFingerprint, "APT public-key fingerprint differs from the approved fingerprint");
  for (const name of expectedAptAssets()) regularFile(path.join(root, name), name);
  invariant(readFileSync(path.join(root, ARCHIVE_KEYRING_FILE)).equals(readFileSync(publicKey)), "release public key differs");
  invariant(readFileSync(path.join(root, APT_SOURCES_FILE), "utf8") === aptSources(repositoryUri), "release source definition differs");
  verifySignatures(root, publicKey);
  await verifyPackageIndex(root, desktopVersion);
  await verifyReleaseFile(root);
  verifyArchiveKeyringPackage(root, publicKey, repositoryUri);
  return expectedAptAssets();
}

function approvedFingerprint(file) {
  regularFile(file, path.basename(file));
  const value = normalizeLf(readFileSync(file, "utf8"));
  invariant(value.endsWith("\n") && value.indexOf("\n") === value.length - 1, "APT fingerprint file must contain one LF-terminated line");
  const fingerprint = value.slice(0, -1);
  invariant(FINGERPRINT.test(fingerprint), "APT fingerprint file is not one canonical fingerprint");
  return fingerprint;
}

/** Build, sign, and independently verify one release's complete APT surface. */
export async function assembleAptRepository({
  directory,
  desktopDeb,
  publicKey,
  fingerprintFile,
  repositoryUri = APT_REPOSITORY_URI,
  date,
}) {
  const fingerprint = approvedFingerprint(fingerprintFile);
  const built = await buildAptRepository({
    outputDirectory: directory,
    desktopDeb,
    publicKey,
    repositoryUri,
    date,
  });
  invariant(built.fingerprint === fingerprint, "APT public key differs from the approved fingerprint file");
  signAptRepository(directory, fingerprint);
  await verifyAptRepository({
    directory,
    desktopVersion: built.desktopVersion,
    publicKey,
    fingerprint,
    repositoryUri,
  });
  return {
    desktopVersion: built.desktopVersion,
    fingerprint,
    assets: expectedAptAssets(),
  };
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "assemble" && (rest.length === 4 || rest.length === 5)) {
    const result = await assembleAptRepository({
      directory: rest[0],
      desktopDeb: rest[1],
      publicKey: rest[2],
      fingerprintFile: rest[3],
      date: rest[4],
    });
    process.stdout.write(`APT repository assembled for Desktop ${result.desktopVersion} (${result.fingerprint})\n`);
  } else if (command === "build" && (rest.length === 3 || rest.length === 4)) {
    const result = await buildAptRepository({
      outputDirectory: rest[0],
      desktopDeb: rest[1],
      publicKey: rest[2],
      date: rest[3],
    });
    process.stdout.write(`APT repository built for Desktop ${result.desktopVersion} (${result.fingerprint})\n`);
  } else if (command === "sign" && rest.length === 2) {
    signAptRepository(rest[0], rest[1]);
    process.stdout.write(`APT repository signed by ${rest[1]}\n`);
  } else if (command === "verify" && rest.length === 4) {
    await verifyAptRepository({
      directory: rest[0],
      desktopVersion: rest[1],
      publicKey: rest[2],
      fingerprint: rest[3],
    });
    process.stdout.write(`APT repository verified for Desktop ${rest[1]} (${rest[3]})\n`);
  } else if (command === "verify-approved" && rest.length === 4) {
    const fingerprint = approvedFingerprint(rest[3]);
    await verifyAptRepository({
      directory: rest[0],
      desktopVersion: rest[1],
      publicKey: rest[2],
      fingerprint,
    });
    process.stdout.write(`APT repository verified for Desktop ${rest[1]} (${fingerprint})\n`);
  } else {
    throw new Error(
      "usage: apt-repository.mjs assemble DIR DESKTOP.deb PUBLIC-KEY.gpg FINGERPRINT.txt [DATE] | build DIR DESKTOP.deb PUBLIC-KEY.gpg [DATE] | sign DIR FINGERPRINT | verify DIR VERSION PUBLIC-KEY.gpg FINGERPRINT | verify-approved DIR VERSION PUBLIC-KEY.gpg FINGERPRINT.txt",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`APT repository failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
