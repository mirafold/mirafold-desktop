#!/usr/bin/env node

// The release job is the only workflow job with a repository-write token. It
// must be able to validate artifacts without `npm ci`, `npx`, or any other
// dependency code running beside that credential. Every release-writer path
// consequently uses Node's standard library only. Read-only platform build
// jobs additionally load electron-builder's exact BLAKE2b implementation to
// prove that each differential-update block checksum describes its payload.

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const NUMBER = "(?:0|[1-9]\\d*)";
export const STABLE_VERSION_RE = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);

const RELEASE_CANDIDATE_RE = /^(?:latest.*\.yml|SHA256SUMS-(?:linux|windows)\.txt|.+\.(?:AppImage|deb|exe|blockmap)|.+\.tar\.gz)$/;
const TOP_LEVEL_KEYS = new Set(["version", "files", "path", "sha512", "releaseDate"]);
const FILE_KEYS = new Set(["url", "sha512", "size", "blockMapSize", "isAdminRightsRequired"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertStableVersion(version) {
  invariant(
    typeof version === "string" && STABLE_VERSION_RE.test(version),
    `release version ${JSON.stringify(version)} is not a stable X.Y.Z version`,
  );
  return version;
}

export function assertReleaseIdentity(tag, packageVersion) {
  assertStableVersion(packageVersion);
  invariant(tag === `v${packageVersion}`, `tag ${tag} does not match package version ${packageVersion}`);
  return packageVersion;
}

export function expectedReleaseAssets(version, platform = "complete") {
  assertStableVersion(version);
  const sets = {
    linux: [
      `Mirafold-${version}.AppImage`,
      "SHA256SUMS-linux.txt",
      "latest-linux.yml",
      `mirafold-desktop-${version}.tar.gz`,
      `mirafold-desktop_${version}_amd64.deb`,
    ],
    windows: [
      `Mirafold-Setup-${version}.exe`,
      `Mirafold-Setup-${version}.exe.blockmap`,
      "SHA256SUMS-windows.txt",
      "latest.yml",
    ],
  };
  invariant(platform === "linux" || platform === "windows" || platform === "complete", `unknown release platform ${platform}`);
  return (platform === "complete" ? [...sets.linux, ...sets.windows] : sets[platform]).sort();
}

export function platformManifestName(platform) {
  invariant(platform === "linux" || platform === "windows", `unknown release platform ${platform}`);
  return `SHA256SUMS-${platform}.txt`;
}

function expectedPlatformPayloads(version, platform) {
  const manifest = platformManifestName(platform);
  return expectedReleaseAssets(version, platform).filter((name) => name !== manifest);
}

function releaseCandidates(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RELEASE_CANDIDATE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function assertExactAssetSet(directory, expected) {
  const actual = releaseCandidates(directory);
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  invariant(
    missing.length === 0 && unexpected.length === 0,
    `release artifact set mismatch; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`,
  );
  for (const name of expected) {
    invariant(statSync(path.join(directory, name)).size > 0, `release artifact ${name} is empty`);
  }
}

function scalar(raw, lineNumber) {
  const value = raw.trim();
  invariant(value.length > 0, `empty update-metadata value on line ${lineNumber}`);
  if (value.startsWith("'") || value.endsWith("'")) {
    invariant(value.length >= 2 && value.startsWith("'") && value.endsWith("'"), `invalid single-quoted scalar on line ${lineNumber}`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') || value.endsWith('"')) {
    invariant(value.length >= 2 && value.startsWith('"') && value.endsWith('"'), `invalid double-quoted scalar on line ${lineNumber}`);
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`invalid double-quoted scalar on line ${lineNumber}`);
    }
  }
  return value;
}

function setOnce(target, key, value, lineNumber) {
  invariant(!(key in target), `duplicate update-metadata key ${key} on line ${lineNumber}`);
  target[key] = value;
}

/** Parse only electron-builder's deterministic UpdateInfo YAML shape. */
export function parseUpdateMetadata(text) {
  const result = {};
  let inFiles = false;
  let currentFile = null;
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line === "") continue;

    if (line === "files:") {
      invariant(!("files" in result), `duplicate update-metadata key files on line ${lineNumber}`);
      result.files = [];
      inFiles = true;
      currentFile = null;
      continue;
    }

    const top = line.match(/^([A-Za-z][A-Za-z0-9]*): (.+)$/);
    if (top) {
      const [, key, raw] = top;
      invariant(TOP_LEVEL_KEYS.has(key) && key !== "files", `unsupported update-metadata key ${key} on line ${lineNumber}`);
      setOnce(result, key, scalar(raw, lineNumber), lineNumber);
      inFiles = false;
      currentFile = null;
      continue;
    }

    const item = line.match(/^  - url: (.+)$/);
    if (item) {
      invariant(inFiles && Array.isArray(result.files), `file entry outside files on line ${lineNumber}`);
      currentFile = { url: scalar(item[1], lineNumber) };
      result.files.push(currentFile);
      continue;
    }

    const property = line.match(/^    ([A-Za-z][A-Za-z0-9]*): (.+)$/);
    if (property) {
      const [, key, raw] = property;
      invariant(inFiles && currentFile !== null, `file property outside an entry on line ${lineNumber}`);
      invariant(FILE_KEYS.has(key) && key !== "url", `unsupported update-file key ${key} on line ${lineNumber}`);
      let value = scalar(raw, lineNumber);
      if (key === "size" || key === "blockMapSize") {
        invariant(/^\d+$/.test(value), `update-file ${key} is not an integer on line ${lineNumber}`);
        value = Number(value);
        invariant(Number.isSafeInteger(value), `update-file ${key} is outside the safe integer range`);
      } else if (key === "isAdminRightsRequired") {
        invariant(value === "true" || value === "false", `update-file ${key} is not boolean on line ${lineNumber}`);
        value = value === "true";
      }
      setOnce(currentFile, key, value, lineNumber);
      continue;
    }

    throw new Error(`unsupported update-metadata syntax on line ${lineNumber}`);
  }

  invariant(typeof result.version === "string", "update metadata has no version");
  invariant(Array.isArray(result.files) && result.files.length > 0, "update metadata has no files");
  invariant(typeof result.path === "string", "update metadata has no compatibility path");
  invariant(typeof result.sha512 === "string", "update metadata has no compatibility SHA-512");
  invariant(typeof result.releaseDate === "string" && !Number.isNaN(Date.parse(result.releaseDate)), "update metadata has no valid release date");
  return result;
}

function assertBase64(value, bytes, label) {
  invariant(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value), `${label} is not base64`);
  const decoded = Buffer.from(value, "base64");
  invariant(decoded.length === bytes && decoded.toString("base64") === value, `${label} is not canonical ${bytes}-byte base64`);
}

function hashFile(file, algorithm = "sha512", encoding = "base64") {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest(encoding)));
  });
}

function assertBlockMap(blockMap, payloadSize, label) {
  invariant(blockMap && typeof blockMap === "object" && blockMap.version === "2", `${label} has an unsupported version`);
  invariant(Array.isArray(blockMap.files) && blockMap.files.length === 1, `${label} must describe exactly one file`);
  const [file] = blockMap.files;
  invariant(file?.name === "file" && file.offset === 0, `${label} has an invalid file record`);
  invariant(Array.isArray(file.sizes) && Array.isArray(file.checksums), `${label} has no chunk arrays`);
  invariant(file.sizes.length > 0 && file.sizes.length === file.checksums.length, `${label} chunk arrays do not align`);
  let describedSize = 0;
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index];
    invariant(Number.isInteger(size) && size > 0 && size <= 32 * 1024, `${label} has invalid chunk size ${size}`);
    assertBase64(file.checksums[index], 18, `${label} chunk ${index} checksum`);
    describedSize += size;
  }
  invariant(describedSize === payloadSize, `${label} describes ${describedSize} bytes, expected ${payloadSize}`);
  return file;
}

async function verifyBlockMapContents(payloadFile, file, label) {
  // Electron-builder/app-builder-lib uses @noble/hashes with an 18-byte output
  // for these checksums. BLAKE2 output length is part of the algorithm, so a
  // truncated 64-byte digest is not equivalent.
  const { blake2b } = await import("@noble/hashes/blake2.js");
  const descriptor = openSync(payloadFile, "r");
  let position = 0;
  try {
    for (let index = 0; index < file.sizes.length; index += 1) {
      const size = file.sizes[index];
      const chunk = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const count = readSync(descriptor, chunk, offset, size - offset, position + offset);
        invariant(count > 0, `unexpected end of ${path.basename(payloadFile)}`);
        offset += count;
      }
      const actual = Buffer.from(blake2b(chunk, { dkLen: 18 })).toString("base64");
      invariant(
        actual === file.checksums[index],
        `${label} chunk ${index} checksum does not match payload bytes`,
      );
      position += size;
    }
  } finally {
    closeSync(descriptor);
  }
}

function readExactly(file, position, length) {
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(file, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const count = readSync(descriptor, buffer, offset, length - offset, position + offset);
      invariant(count > 0, `unexpected end of ${path.basename(file)}`);
      offset += count;
    }
  } finally {
    closeSync(descriptor);
  }
  return buffer;
}

async function verifyEmbeddedAppImageBlockMap(file, declaredSize, verifyContents) {
  const fileSize = statSync(file).size;
  invariant(Number.isInteger(declaredSize) && declaredSize > 0 && declaredSize < fileSize - 4, "AppImage metadata has no valid embedded block-map size");
  const header = readExactly(file, fileSize - 4, 4).readUInt32BE(0);
  invariant(header === declaredSize, `AppImage embedded block-map header ${header} != metadata ${declaredSize}`);
  const compressed = readExactly(file, fileSize - 4 - declaredSize, declaredSize);
  let blockMap;
  try {
    blockMap = JSON.parse(inflateRawSync(compressed).toString("utf8"));
  } catch {
    throw new Error("AppImage embedded block map is not valid deflated JSON");
  }
  const record = assertBlockMap(
    blockMap,
    fileSize - declaredSize - 4,
    "AppImage embedded block map",
  );
  if (verifyContents) await verifyBlockMapContents(file, record, "AppImage embedded block map");
}

async function verifyExternalWindowsBlockMap(file, installer, verifyContents) {
  let blockMap;
  try {
    blockMap = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  } catch {
    throw new Error("Windows block map is not valid gzipped JSON");
  }
  const record = assertBlockMap(blockMap, statSync(installer).size, "Windows block map");
  if (verifyContents) await verifyBlockMapContents(installer, record, "Windows block map");
}

async function verifyUpdateMetadata(
  directory,
  version,
  platform,
  { verifyBlockContents = false } = {},
) {
  const metadataName = platform === "linux" ? "latest-linux.yml" : "latest.yml";
  const metadata = parseUpdateMetadata(readFileSync(path.join(directory, metadataName), "utf8"));
  invariant(metadata.version === version, `${metadataName} version ${metadata.version} != ${version}`);

  const expectedPayloads = platform === "linux"
    ? [`Mirafold-${version}.AppImage`, `mirafold-desktop_${version}_amd64.deb`]
    : [`Mirafold-Setup-${version}.exe`];
  const actualPayloads = metadata.files.map((file) => file.url).sort();
  invariant(
    JSON.stringify(actualPayloads) === JSON.stringify([...expectedPayloads].sort()),
    `${metadataName} payloads [${actualPayloads.join(", ")}] != [${expectedPayloads.join(", ")}]`,
  );

  const seen = new Set();
  for (const info of metadata.files) {
    invariant(!seen.has(info.url), `${metadataName} repeats payload ${info.url}`);
    seen.add(info.url);
    invariant(typeof info.sha512 === "string", `${metadataName} payload ${info.url} has no SHA-512`);
    assertBase64(info.sha512, 64, `${metadataName} payload ${info.url} SHA-512`);
    const artifact = path.join(directory, info.url);
    const size = statSync(artifact).size;
    invariant(info.size === size, `${metadataName} payload ${info.url} size ${info.size} != ${size}`);
    invariant((await hashFile(artifact)) === info.sha512, `${metadataName} payload ${info.url} SHA-512 does not match`);
    if (info.url.endsWith(".AppImage")) {
      await verifyEmbeddedAppImageBlockMap(artifact, info.blockMapSize, verifyBlockContents);
    } else {
      invariant(info.blockMapSize === undefined, `${metadataName} unexpectedly embeds a block map for ${info.url}`);
    }
  }

  const primary = expectedPayloads[0];
  const primaryInfo = metadata.files.find((file) => file.url === primary);
  invariant(metadata.path === primary, `${metadataName} compatibility path ${metadata.path} != ${primary}`);
  invariant(metadata.sha512 === primaryInfo.sha512, `${metadataName} compatibility SHA-512 differs from ${primary}`);

  if (platform === "windows") {
    const installer = path.join(directory, primary);
    await verifyExternalWindowsBlockMap(`${installer}.blockmap`, installer, verifyBlockContents);
  }
}

export async function verifyPlatformArtifacts(directory, version, platform) {
  assertStableVersion(version);
  const expected = expectedReleaseAssets(version, platform);
  assertExactAssetSet(directory, expected);
  await verifyUpdateMetadata(directory, version, platform, { verifyBlockContents: true });
  await verifyPlatformManifest(directory, version, platform);
  return expected;
}

export async function verifyPlatformPayloadArtifacts(directory, version, platform) {
  assertStableVersion(version);
  const expected = expectedPlatformPayloads(version, platform);
  assertExactAssetSet(directory, expected);
  await verifyUpdateMetadata(directory, version, platform, { verifyBlockContents: true });
  return expected;
}

export async function createPlatformManifest(directory, version, platform) {
  const expected = await verifyPlatformPayloadArtifacts(directory, version, platform);
  const manifestName = platformManifestName(platform);
  const manifestPath = path.join(directory, manifestName);
  invariant(!existsSync(manifestPath), `${manifestName} already exists`);
  const lines = [];
  for (const name of expected) {
    const digest = await hashFile(path.join(directory, name), "sha256", "hex");
    lines.push(`${digest}  ${name}`);
  }
  writeFileSync(manifestPath, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o644 });
  await verifyPlatformArtifacts(directory, version, platform);
  return manifestName;
}

export async function verifyPlatformManifest(directory, version, platform) {
  const manifestName = platformManifestName(platform);
  const manifestPath = path.join(directory, manifestName);
  const record = lstatSync(manifestPath);
  invariant(record.isFile(), `${manifestName} must be a regular file`);
  invariant(record.size <= 64 * 1024, `${manifestName} is too large`);
  const text = readFileSync(manifestPath, "utf8");
  invariant(text.endsWith("\n") && !text.includes("\r"), `${manifestName} must use canonical LF lines`);
  const lines = text.slice(0, -1).split("\n");
  const expected = expectedPlatformPayloads(version, platform);
  invariant(lines.length === expected.length, `${manifestName} entry count ${lines.length} != ${expected.length}`);
  for (let index = 0; index < expected.length; index += 1) {
    const match = lines[index].match(/^([a-f0-9]{64})  (.+)$/);
    invariant(match !== null, `${manifestName} line ${index + 1} is not canonical SHA-256 syntax`);
    const [, declared, name] = match;
    invariant(name === expected[index], `${manifestName} line ${index + 1} names ${name}, expected ${expected[index]}`);
    const actual = await hashFile(path.join(directory, name), "sha256", "hex");
    invariant(declared === actual, `${manifestName} SHA-256 for ${name} does not match`);
  }
  return expected;
}

export async function verifyCompleteArtifacts(directory, version) {
  assertStableVersion(version);
  const expected = expectedReleaseAssets(version, "complete");
  assertExactAssetSet(directory, expected);
  await verifyUpdateMetadata(directory, version, "linux");
  await verifyUpdateMetadata(directory, version, "windows");
  await verifyPlatformManifest(directory, version, "linux");
  await verifyPlatformManifest(directory, version, "windows");
  return expected;
}

export async function verifyGitHubRelease(release, directory, tag, version, { draft }) {
  assertReleaseIdentity(tag, version);
  invariant(release && typeof release === "object", "GitHub release response is not an object");
  invariant(release.tagName === tag, `GitHub release tag ${release.tagName} != ${tag}`);
  invariant(release.isDraft === draft, draft
    ? "GitHub release became public before artifact verification"
    : "GitHub release is still a draft after publication");
  invariant(release.isPrerelease === false, "stable Mirafold release was marked as a prerelease");
  invariant(Array.isArray(release.assets), "GitHub release has no asset list");

  const expected = expectedReleaseAssets(version, "complete");
  const names = release.assets.map((asset) => asset?.name).sort();
  invariant(JSON.stringify(names) === JSON.stringify(expected), `GitHub release assets [${names.join(", ")}] do not match the complete release set`);
  for (const asset of release.assets) {
    const localFile = path.join(directory, asset.name);
    const localSize = statSync(localFile).size;
    invariant(asset.size === localSize, `GitHub release asset ${asset.name} size ${asset.size} != ${localSize}`);
    const localDigest = await hashFile(localFile, "sha256", "hex");
    invariant(
      asset.digest === `sha256:${localDigest}`,
      `GitHub release asset ${asset.name} SHA-256 does not match`,
    );
  }
  return expected;
}

export async function verifyGitHubDraft(release, directory, tag, version) {
  return verifyGitHubRelease(release, directory, tag, version, { draft: true });
}

export async function verifyGitHubPublished(release, latest, directory, tag, version) {
  const expected = await verifyGitHubRelease(release, directory, tag, version, { draft: false });
  invariant(latest && typeof latest === "object", "GitHub latest-release response is not an object");
  invariant(latest.tagName === tag, `GitHub latest release ${latest.tagName} != ${tag}`);
  invariant(latest.isDraft === false, "GitHub latest release is a draft");
  invariant(latest.isPrerelease === false, "GitHub latest release is a prerelease");
  return expected;
}

function packageVersion() {
  const metadata = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return metadata.version;
}

async function main(args) {
  const [command, ...rest] = args;
  const version = packageVersion();
  if (command === "identity" && rest.length === 1) {
    assertReleaseIdentity(rest[0], version);
  } else if (command === "platform" && rest.length === 2) {
    await verifyPlatformArtifacts(path.resolve(rest[1]), version, rest[0]);
  } else if (command === "payload" && rest.length === 2) {
    await verifyPlatformPayloadArtifacts(path.resolve(rest[1]), version, rest[0]);
  } else if (command === "manifest" && rest.length === 2) {
    await createPlatformManifest(path.resolve(rest[1]), version, rest[0]);
  } else if (command === "complete" && rest.length === 2) {
    assertReleaseIdentity(rest[0], version);
    await verifyCompleteArtifacts(path.resolve(rest[1]), version);
  } else if (command === "artifacts" && rest.length === 1) {
    await verifyCompleteArtifacts(path.resolve(rest[0]), version);
  } else if (command === "draft" && rest.length === 3) {
    const release = JSON.parse(readFileSync(path.resolve(rest[2]), "utf8"));
    await verifyGitHubDraft(release, path.resolve(rest[1]), rest[0], version);
  } else if (command === "published" && rest.length === 4) {
    const release = JSON.parse(readFileSync(path.resolve(rest[2]), "utf8"));
    const latest = JSON.parse(readFileSync(path.resolve(rest[3]), "utf8"));
    await verifyGitHubPublished(release, latest, path.resolve(rest[1]), rest[0], version);
  } else {
    throw new Error(
      "usage: release-contract.mjs identity TAG | payload linux|windows DIR | manifest linux|windows DIR | platform linux|windows DIR | artifacts DIR | complete TAG DIR | draft TAG DIR RELEASE.json | published TAG DIR RELEASE.json LATEST.json",
    );
  }
  process.stdout.write(`release contract verified: ${command} ${version}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release contract failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
