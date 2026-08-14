import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  assertReleaseIdentity,
  createPlatformManifest,
  expectedReleaseAssets,
  parseUpdateMetadata,
  verifyCompleteArtifacts,
  verifyGitHubDraft,
  verifyGitHubPublished,
  verifyPlatformArtifacts,
} from "../scripts/release-contract.mjs";

const VERSION = "1.2.3";
const TAG = `v${VERSION}`;

function sha512(value) {
  return createHash("sha512").update(value).digest("base64");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function blockMap(payload) {
  return {
    version: "2",
    files: [
      {
        name: "file",
        offset: 0,
        checksums: [Buffer.from(blake2b(payload, { dkLen: 18 })).toString("base64")],
        sizes: [payload.length],
      },
    ],
  };
}

function updateYaml(version, files, primary) {
  const fileLines = files.flatMap((file) => [
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
    ...(file.blockMapSize === undefined ? [] : [`    blockMapSize: ${file.blockMapSize}`]),
  ]);
  return [
    `version: ${version}`,
    "files:",
    ...fileLines,
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    "releaseDate: '2026-08-13T12:00:00.000Z'",
    "",
  ].join("\n");
}

function writeLinuxPayloads(directory) {
  const appImageBase = Buffer.from("a complete tiny AppImage fixture");
  const embeddedMap = deflateRawSync(Buffer.from(JSON.stringify(blockMap(appImageBase))));
  const sizeHeader = Buffer.alloc(4);
  sizeHeader.writeUInt32BE(embeddedMap.length);
  const appImage = Buffer.concat([appImageBase, embeddedMap, sizeHeader]);
  const deb = Buffer.from("a complete tiny Debian fixture");
  const tar = Buffer.from("a complete tiny tar fixture");
  const appImageName = `Mirafold-${VERSION}.AppImage`;
  const debName = `mirafold-desktop_${VERSION}_amd64.deb`;

  writeFileSync(path.join(directory, appImageName), appImage);
  writeFileSync(path.join(directory, debName), deb);
  writeFileSync(path.join(directory, `mirafold-desktop-${VERSION}.tar.gz`), tar);
  const files = [
    { url: appImageName, sha512: sha512(appImage), size: appImage.length, blockMapSize: embeddedMap.length },
    { url: debName, sha512: sha512(deb), size: deb.length },
  ];
  writeFileSync(path.join(directory, "latest-linux.yml"), updateYaml(VERSION, files, files[0]));
}

async function writeLinux(directory) {
  writeLinuxPayloads(directory);
  await createPlatformManifest(directory, VERSION, "linux");
}

function writeWindowsPayloads(directory) {
  const installer = Buffer.from("a complete tiny NSIS fixture");
  const installerName = `Mirafold-Setup-${VERSION}.exe`;
  writeFileSync(path.join(directory, installerName), installer);
  writeFileSync(
    path.join(directory, `${installerName}.blockmap`),
    gzipSync(Buffer.from(JSON.stringify(blockMap(installer)))),
  );
  const files = [{ url: installerName, sha512: sha512(installer), size: installer.length }];
  writeFileSync(path.join(directory, "latest.yml"), updateYaml(VERSION, files, files[0]));
}

async function writeWindows(directory) {
  writeWindowsPayloads(directory);
  await createPlatformManifest(directory, VERSION, "windows");
}

async function writeComplete(directory) {
  const linux = path.join(directory, "linux-build");
  const windows = path.join(directory, "windows-build");
  mkdirSync(linux);
  mkdirSync(windows);
  await writeLinux(linux);
  await writeWindows(windows);
  for (const platformDirectory of [linux, windows]) {
    for (const name of readdirSync(platformDirectory)) {
      copyFileSync(path.join(platformDirectory, name), path.join(directory, name));
    }
    rmSync(platformDirectory, { recursive: true });
  }
}

async function temporaryDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "mirafold-release-contract-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("release identity accepts only an exactly matching stable tag", () => {
  assert.equal(assertReleaseIdentity("v1.2.3", "1.2.3"), "1.2.3");
  assert.throws(() => assertReleaseIdentity("v1.2.4", "1.2.3"), /does not match/);
  assert.throws(
    () => assertReleaseIdentity("v1.2.3-beta.1", "1.2.3-beta.1"),
    /not a stable X\.Y\.Z version/,
    "a prerelease must never be published into the stable latest channel",
  );
});

test("platform contracts verify every payload, checksum, and block map", async () => {
  await temporaryDirectory(async (linux) => {
    await writeLinux(linux);
    assert.deepEqual(await verifyPlatformArtifacts(linux, VERSION, "linux"), expectedReleaseAssets(VERSION, "linux"));
  });
  await temporaryDirectory(async (windows) => {
    await writeWindows(windows);
    assert.deepEqual(await verifyPlatformArtifacts(windows, VERSION, "windows"), expectedReleaseAssets(VERSION, "windows"));
  });
});

test("platform verification rejects a canonical but false block checksum", async () => {
  await temporaryDirectory(async (directory) => {
    await writeWindows(directory);
    const installer = readFileSync(path.join(directory, `Mirafold-Setup-${VERSION}.exe`));
    const blockMapFile = path.join(directory, `Mirafold-Setup-${VERSION}.exe.blockmap`);
    const parsed = JSON.parse(gunzipSync(readFileSync(blockMapFile)).toString("utf8"));
    parsed.files[0].sizes = [10, installer.length - 10];
    parsed.files[0].checksums = [
      Buffer.from(blake2b(installer.subarray(0, 10), { dkLen: 18 })).toString("base64"),
      Buffer.alloc(18, 9).toString("base64"),
    ];
    writeFileSync(blockMapFile, gzipSync(Buffer.from(JSON.stringify(parsed))));

    await assert.rejects(
      verifyPlatformArtifacts(directory, VERSION, "windows"),
      /Windows block map chunk 1 checksum does not match payload bytes/,
    );
  });
});

test("the complete release-writer contract runs without installed dependency code", async () => {
  await temporaryDirectory(async (directory) => {
    const assets = path.join(directory, "assets");
    const isolatedScripts = path.join(directory, "isolated", "scripts");
    mkdirSync(assets);
    mkdirSync(isolatedScripts, { recursive: true });
    await writeComplete(assets);
    const isolatedContract = path.join(isolatedScripts, "release-contract.mjs");
    copyFileSync(new URL("../scripts/release-contract.mjs", import.meta.url), isolatedContract);
    assert.equal(existsSync(path.join(directory, "isolated", "node_modules")), false);

    const writerContract = await import(pathToFileURL(isolatedContract).href);
    assert.deepEqual(
      await writerContract.verifyCompleteArtifacts(assets, VERSION),
      expectedReleaseAssets(VERSION),
    );
  });
});

test("the complete contract rejects omitted metadata and blockmaps", async () => {
  await temporaryDirectory(async (directory) => {
    await writeComplete(directory);
    assert.deepEqual(await verifyCompleteArtifacts(directory, VERSION), expectedReleaseAssets(VERSION));

    unlinkSync(path.join(directory, "latest.yml"));
    await assert.rejects(verifyCompleteArtifacts(directory, VERSION), /missing=\[latest\.yml\]/);
  });

  await temporaryDirectory(async (directory) => {
    await writeWindows(directory);
    unlinkSync(path.join(directory, `Mirafold-Setup-${VERSION}.exe.blockmap`));
    await assert.rejects(
      verifyPlatformArtifacts(directory, VERSION, "windows"),
      /missing=\[Mirafold-Setup-1\.2\.3\.exe\.blockmap\]/,
    );
  });
});

test("metadata whose payload was changed after generation is refused", async () => {
  await temporaryDirectory(async (directory) => {
    await writeLinux(directory);
    writeFileSync(path.join(directory, `mirafold-desktop_${VERSION}_amd64.deb`), "tampered");
    await assert.rejects(verifyPlatformArtifacts(directory, VERSION, "linux"), /size .* !=/);
  });
});

test("manifests canonically bind every platform payload with SHA-256", async () => {
  await temporaryDirectory(async (directory) => {
    writeLinuxPayloads(directory);
    assert.equal(await createPlatformManifest(directory, VERSION, "linux"), "SHA256SUMS-linux.txt");
    const manifest = readFileSync(path.join(directory, "SHA256SUMS-linux.txt"), "utf8");
    const names = manifest.trimEnd().split("\n").map((line) => line.slice(66));
    assert.deepEqual(names, [
      `Mirafold-${VERSION}.AppImage`,
      "latest-linux.yml",
      `mirafold-desktop-${VERSION}.tar.gz`,
      `mirafold-desktop_${VERSION}_amd64.deb`,
    ]);
    assert.match(manifest, /^(?:[a-f0-9]{64}  [^\n]+\n){4}$/);

    writeFileSync(path.join(directory, `mirafold-desktop-${VERSION}.tar.gz`), "tampered after manifest");
    await assert.rejects(
      verifyPlatformArtifacts(directory, VERSION, "linux"),
      /SHA-256 .* does not match/,
    );
  });
});

test("manifest generation refuses partial payload sets and existing manifests", async () => {
  await temporaryDirectory(async (directory) => {
    writeLinuxPayloads(directory);
    unlinkSync(path.join(directory, `mirafold-desktop-${VERSION}.tar.gz`));
    await assert.rejects(
      createPlatformManifest(directory, VERSION, "linux"),
      /missing=\[mirafold-desktop-1\.2\.3\.tar\.gz\]/,
    );
  });
  await temporaryDirectory(async (directory) => {
    writeWindowsPayloads(directory);
    await createPlatformManifest(directory, VERSION, "windows");
    await assert.rejects(
      createPlatformManifest(directory, VERSION, "windows"),
      /unexpected=\[SHA256SUMS-windows\.txt\]/,
    );
  });
});

test("the strict metadata parser refuses duplicate or unrecognized keys", () => {
  const valid = updateYaml(
    VERSION,
    [{ url: "Mirafold.exe", sha512: Buffer.alloc(64).toString("base64"), size: 10 }],
    { url: "Mirafold.exe", sha512: Buffer.alloc(64).toString("base64") },
  );
  assert.equal(parseUpdateMetadata(valid).version, VERSION);
  assert.throws(() => parseUpdateMetadata(`version: ${VERSION}\nversion: ${VERSION}\n${valid.slice(valid.indexOf("files:"))}`), /duplicate/);
  assert.throws(() => parseUpdateMetadata(`${valid}surprise: value\n`), /unsupported update-metadata key/);
});

test("a GitHub release stays a stable draft until its complete remote assets match", async () => {
  await temporaryDirectory(async (directory) => {
    await writeComplete(directory);
    const assets = expectedReleaseAssets(VERSION).map((name) => ({
      name,
      size: statSync(path.join(directory, name)).size,
      digest: `sha256:${sha256(readFileSync(path.join(directory, name)))}`,
    }));
    const release = { tagName: TAG, isDraft: true, isPrerelease: false, assets };

    assert.deepEqual(await verifyGitHubDraft(release, directory, TAG, VERSION), expectedReleaseAssets(VERSION));
    await assert.rejects(
      verifyGitHubDraft({ ...release, isDraft: false }, directory, TAG, VERSION),
      /became public before artifact verification/,
    );
    await assert.rejects(
      verifyGitHubDraft({ ...release, isPrerelease: true }, directory, TAG, VERSION),
      /marked as a prerelease/,
    );
    await assert.rejects(
      verifyGitHubDraft({ ...release, assets: assets.slice(1) }, directory, TAG, VERSION),
      /do not match the complete release set/,
    );
    const sameSizeSubstitution = assets.map((asset, index) => index === 0
      ? { ...asset, digest: `sha256:${"0".repeat(64)}` }
      : asset);
    await assert.rejects(
      verifyGitHubDraft({ ...release, assets: sameSizeSubstitution }, directory, TAG, VERSION),
      /SHA-256 does not match/,
    );
  });
});

test("a published release must remain complete, stable, and GitHub latest", async () => {
  await temporaryDirectory(async (directory) => {
    await writeComplete(directory);
    const assets = expectedReleaseAssets(VERSION).map((name) => ({
      name,
      size: statSync(path.join(directory, name)).size,
      digest: `sha256:${sha256(readFileSync(path.join(directory, name)))}`,
    }));
    const release = { tagName: TAG, isDraft: false, isPrerelease: false, assets };
    const latest = { tagName: TAG, isDraft: false, isPrerelease: false };
    assert.deepEqual(
      await verifyGitHubPublished(release, latest, directory, TAG, VERSION),
      expectedReleaseAssets(VERSION),
    );
    await assert.rejects(
      verifyGitHubPublished({ ...release, isDraft: true }, latest, directory, TAG, VERSION),
      /still a draft/,
    );
    await assert.rejects(
      verifyGitHubPublished(release, { ...latest, tagName: "v9.9.9" }, directory, TAG, VERSION),
      /latest release v9\.9\.9 != v1\.2\.3/,
    );
  });
});
