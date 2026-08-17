import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  automatedCommitMessage,
  automatedReleaseNotes,
  classifyRemoteRelease,
  inspectRemoteRelease,
  prepareReleaseCandidate,
  RELEASE_PLAN_SCHEMA_VERSION,
  validateReleasePlan,
  verifyLocalReleaseCandidate,
  verifyReleaseNotes,
} from "../scripts/release-coordinator.mjs";
import { expectedReleaseAssets } from "../scripts/release-contract.mjs";

const VERSION = "1.2.4";
const SHELL_VERSION = "0.3.8";
const BASE = "1".repeat(40);
const TREE = "2".repeat(40);
const COMMIT = "3".repeat(40);
const SOURCE = "4".repeat(40);
const HASH = "5".repeat(64);
const NOTES = "fixture release notes\n";

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(algorithm, value, encoding) {
  return createHash(algorithm).update(value).digest(encoding);
}

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, String(result.stderr));
  return String(result.stdout).trim();
}

function packagePair(desktopVersion, shellVersion, integrityByte) {
  const tarball = `https://registry.npmjs.org/mirafold/-/mirafold-${shellVersion}.tgz`;
  const integrity = `sha512-${Buffer.alloc(64, integrityByte).toString("base64")}`;
  const packageMetadata = {
    name: "mirafold-desktop-fixture",
    version: desktopVersion,
    private: true,
    dependencies: { mirafold: shellVersion },
  };
  const lockMetadata = {
    name: packageMetadata.name,
    version: desktopVersion,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageMetadata.name,
        version: desktopVersion,
        dependencies: { mirafold: shellVersion },
      },
      "node_modules/mirafold": {
        version: shellVersion,
        resolved: tarball,
        integrity,
      },
    },
  };
  return {
    packageText: jsonText(packageMetadata),
    lockText: jsonText(lockMetadata),
    integrity,
    tarball,
  };
}

function tinyBlockMap(payload) {
  return {
    version: "2",
    files: [{
      name: "file",
      offset: 0,
      checksums: [Buffer.alloc(18, 3).toString("base64")],
      sizes: [payload.length],
    }],
  };
}

function updateYaml(version, files, primary) {
  return [
    `version: ${version}`,
    "files:",
    ...files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
      ...(file.blockMapSize === undefined ? [] : [`    blockMapSize: ${file.blockMapSize}`]),
    ]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    "releaseDate: '2026-08-13T12:00:00.000Z'",
    "",
  ].join("\n");
}

function writeCompleteAssets(directory, version) {
  mkdirSync(directory, { recursive: true });
  const appImagePayload = Buffer.from("tiny AppImage payload");
  const embedded = deflateRawSync(Buffer.from(JSON.stringify(tinyBlockMap(appImagePayload))));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(embedded.length);
  const appImage = Buffer.concat([appImagePayload, embedded, header]);
  const deb = Buffer.from("tiny Debian payload");
  const appImageName = `Mirafold-${version}.AppImage`;
  const debName = `mirafold-desktop_${version}_amd64.deb`;
  writeFileSync(path.join(directory, appImageName), appImage);
  writeFileSync(path.join(directory, debName), deb);
  writeFileSync(path.join(directory, `mirafold-desktop-${version}.tar.gz`), "tiny tar payload");
  const linuxFiles = [
    { url: appImageName, sha512: digest("sha512", appImage, "base64"), size: appImage.length, blockMapSize: embedded.length },
    { url: debName, sha512: digest("sha512", deb, "base64"), size: deb.length },
  ];
  writeFileSync(path.join(directory, "latest-linux.yml"), updateYaml(version, linuxFiles, linuxFiles[0]));

  const installer = Buffer.from("tiny NSIS payload");
  const installerName = `Mirafold-Setup-${version}.exe`;
  writeFileSync(path.join(directory, installerName), installer);
  writeFileSync(
    path.join(directory, `${installerName}.blockmap`),
    gzipSync(Buffer.from(JSON.stringify(tinyBlockMap(installer)))),
  );
  const windowsFiles = [{
    url: installerName,
    sha512: digest("sha512", installer, "base64"),
    size: installer.length,
  }];
  writeFileSync(path.join(directory, "latest.yml"), updateYaml(version, windowsFiles, windowsFiles[0]));

  for (const platform of ["linux", "windows"]) {
    const manifestName = `SHA256SUMS-${platform}.txt`;
    const lines = expectedReleaseAssets(version, platform)
      .filter((name) => name !== manifestName)
      .map((name) => `${digest("sha256", readFileSync(path.join(directory, name)), "hex")}  ${name}`);
    writeFileSync(path.join(directory, manifestName), `${lines.join("\n")}\n`);
  }
}

function plan({
  baseCommit = BASE,
  candidateTree = TREE,
  desktopVersion = VERSION,
  shellVersion = SHELL_VERSION,
  sourceCommit = SOURCE,
} = {}) {
  return {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    repository: "mirafold/mirafold-desktop",
    branch: "main",
    baseCommit,
    candidateTree,
    desktopVersion,
    shell: {
      version: shellVersion,
      sourceCommit,
      sourceRef: `refs/tags/v${shellVersion}`,
    },
    tag: `v${desktopVersion}`,
    commitMessage: automatedCommitMessage(desktopVersion, shellVersion),
    tagMessage: `Mirafold Desktop v${desktopVersion}`,
    releaseTitle: `Mirafold Desktop v${desktopVersion}`,
    files: {
      "package.json": HASH,
      "package-lock.json": "6".repeat(64),
    },
    assets: expectedReleaseAssets(desktopVersion).map((name, index) => ({
      name,
      size: 100 + index,
      sha256: digest("sha256", name, "hex"),
    })),
    notesSha256: digest("sha256", NOTES, "hex"),
  };
}

function candidateMain(overrides = {}) {
  return {
    sha: COMMIT,
    commit: COMMIT,
    parent: BASE,
    tree: TREE,
    message: automatedCommitMessage(VERSION, SHELL_VERSION),
    ...overrides,
  };
}

function remoteRelease(candidate, overrides = {}) {
  return {
    tagName: candidate.tag,
    title: candidate.releaseTitle,
    body: NOTES,
    isDraft: true,
    isPrerelease: false,
    assets: candidate.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      digest: `sha256:${asset.sha256}`,
    })),
    ...overrides,
  };
}

function retryState(candidate, overrides = {}) {
  return {
    main: candidateMain(),
    tag: { annotated: true, commit: COMMIT },
    release: null,
    latest: null,
    ...overrides,
  };
}

test("automated identity and release notes are deterministic and source-bound", () => {
  const candidate = plan();
  assert.equal(validateReleasePlan(candidate), candidate);
  assert.equal(
    candidate.commitMessage,
    "release: Desktop 1.2.4 with Shell 0.3.8\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  );
  const notes = automatedReleaseNotes({
    desktopVersion: VERSION,
    shell: { version: SHELL_VERSION },
    source: {
      repository: "https://github.com/mirafold/mirafold",
      ref: `refs/tags/v${SHELL_VERSION}`,
      commit: SOURCE,
    },
  });
  assert.match(notes, /Mirafold Desktop `1\.2\.4`/);
  assert.match(notes, /Mirafold Shell `0\.3\.8`/);
  assert.match(notes, new RegExp(SOURCE));
  assert.throws(
    () => validateReleasePlan({ ...candidate, repository: "attacker/example" }),
    /repository differs/,
  );
});

test("a clean intake base with no tag or release creates exactly one candidate", () => {
  const candidate = plan();
  assert.deepEqual(classifyRemoteRelease(candidate, {
    main: { sha: BASE },
    tag: null,
    release: null,
    latest: null,
  }), { mode: "create", releaseCommit: null });
});

test("a retry resumes each safe post-push and draft state", () => {
  const candidate = plan();
  assert.deepEqual(
    classifyRemoteRelease(candidate, retryState(candidate)),
    { mode: "release-create", releaseCommit: COMMIT },
  );
  assert.deepEqual(
    classifyRemoteRelease(candidate, retryState(candidate, {
      release: remoteRelease(candidate, { body: NOTES.trimEnd() }),
    })),
    { mode: "draft-complete", releaseCommit: COMMIT },
  );
  assert.deepEqual(
    classifyRemoteRelease(candidate, retryState(candidate, {
      release: remoteRelease(candidate, { assets: candidate.assets.slice(1) }),
    })),
    { mode: "draft-replace", releaseCommit: COMMIT },
  );
  assert.deepEqual(
    classifyRemoteRelease(candidate, retryState(candidate, {
      release: remoteRelease(candidate, { isPrerelease: true }),
    })),
    { mode: "draft-replace", releaseCommit: COMMIT },
  );
  assert.deepEqual(
    classifyRemoteRelease(candidate, retryState(candidate, {
      release: remoteRelease(candidate, { body: "different notes\n" }),
    })),
    { mode: "draft-replace", releaseCommit: COMMIT },
  );
});

test("a duplicate schedule becomes an idempotent no-op only after a complete latest release", () => {
  const candidate = plan();
  const published = remoteRelease(candidate, { isDraft: false });
  assert.deepEqual(classifyRemoteRelease(candidate, retryState(candidate, {
    release: published,
    latest: { tagName: candidate.tag, isDraft: false, isPrerelease: false },
  })), { mode: "complete", releaseCommit: COMMIT });

  assert.throws(
    () => classifyRemoteRelease(candidate, retryState(candidate, {
      release: { ...published, assets: candidate.assets.slice(1) },
      latest: { tagName: candidate.tag, isDraft: false, isPrerelease: false },
    })),
    /published release assets differ/,
  );
  assert.throws(
    () => classifyRemoteRelease(candidate, retryState(candidate, {
      release: {
        ...published,
        assets: published.assets.map((asset, index) => index === 0
          ? { ...asset, digest: `sha256:${"0".repeat(64)}` }
          : asset),
      },
      latest: { tagName: candidate.tag, isDraft: false, isPrerelease: false },
    })),
    /published release assets differ/,
  );
  assert.throws(
    () => classifyRemoteRelease(candidate, retryState(candidate, {
      release: { ...published, title: "Different title" },
      latest: { tagName: candidate.tag, isDraft: false, isPrerelease: false },
    })),
    /title or notes differ/,
  );
  assert.throws(
    () => classifyRemoteRelease(candidate, retryState(candidate, {
      release: published,
      latest: { tagName: "v9.9.9", isDraft: false, isPrerelease: false },
    })),
    /not GitHub's latest release/,
  );
});

test("a rapid second Shell update from the same base fails closed, then proceeds from current main", () => {
  const first = plan();
  const second = plan({
    candidateTree: "7".repeat(40),
    shellVersion: "0.3.9",
    sourceCommit: "8".repeat(40),
  });
  const publishedFirst = remoteRelease(first, { isDraft: false });
  const afterFirst = retryState(first, {
    release: publishedFirst,
    latest: { tagName: first.tag, isDraft: false, isPrerelease: false },
  });

  assert.throws(
    () => classifyRemoteRelease(second, afterFirst),
    /tree differs from reviewed candidate/,
    "a queued candidate prepared from the old base must not replace the first release",
  );

  const retriedFromCurrentMain = plan({
    baseCommit: COMMIT,
    candidateTree: "9".repeat(40),
    desktopVersion: "1.2.5",
    shellVersion: "0.3.9",
    sourceCommit: "8".repeat(40),
  });
  assert.deepEqual(classifyRemoteRelease(retriedFromCurrentMain, {
    main: { sha: COMMIT },
    tag: null,
    release: null,
    latest: null,
  }), { mode: "create", releaseCommit: null });
});

test("stale main, competing candidates, and tag collisions fail closed", () => {
  const candidate = plan();
  assert.throws(
    () => classifyRemoteRelease(candidate, {
      main: { sha: "8".repeat(40) }, tag: null, release: null, latest: null,
    }),
    /main moved from the intake base/,
  );
  assert.throws(
    () => classifyRemoteRelease(candidate, {
      main: { sha: BASE }, tag: { annotated: true, commit: COMMIT }, release: null, latest: null,
    }),
    /collides while main still equals/,
  );
  for (const [field, value, message] of [
    ["parent", "8".repeat(40), /parent differs/],
    ["tree", "8".repeat(40), /tree differs/],
    ["message", "competing release", /message differs/],
  ]) {
    assert.throws(
      () => classifyRemoteRelease(candidate, retryState(candidate, {
        main: candidateMain({ [field]: value }),
      })),
      message,
    );
  }
  assert.throws(
    () => classifyRemoteRelease(candidate, retryState(candidate, {
      tag: { annotated: false, commit: COMMIT },
    })),
    /not annotated/,
  );
  assert.throws(
    () => classifyRemoteRelease(candidate, retryState(candidate, {
      tag: { annotated: true, commit: "8".repeat(40) },
    })),
    /does not point/,
  );
});

test("remote inspection peels the annotated tag and normalizes GitHub release state", async () => {
  const candidate = plan();
  const tagObject = "9".repeat(40);
  const responses = new Map([
    ["/git/ref/heads/main", { object: { type: "commit", sha: COMMIT } }],
    [`/git/commits/${COMMIT}`, {
      sha: COMMIT,
      parents: [{ sha: BASE }],
      tree: { sha: TREE },
      message: candidate.commitMessage,
    }],
    [`/git/ref/tags/${candidate.tag}`, { object: { type: "tag", sha: tagObject } }],
    [`/git/tags/${tagObject}`, { object: { type: "commit", sha: COMMIT } }],
    [`/releases/tags/${candidate.tag}`, {
      tag_name: candidate.tag,
      name: candidate.releaseTitle,
      body: NOTES,
      draft: false,
      prerelease: false,
      assets: candidate.assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        digest: `sha256:${asset.sha256}`,
      })),
    }],
    ["/releases/latest", {
      tag_name: candidate.tag,
      name: candidate.releaseTitle,
      body: NOTES,
      draft: false,
      prerelease: false,
      assets: candidate.assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        digest: `sha256:${asset.sha256}`,
      })),
    }],
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname.replace(`/repos/${candidate.repository}`, "");
    calls.push({ pathname, authorization: options.headers.Authorization });
    const value = responses.get(pathname);
    return {
      status: value === undefined ? 404 : 200,
      ok: value !== undefined,
      json: async () => value,
    };
  };
  const state = await inspectRemoteRelease(candidate, { token: "test-token", fetchImpl });
  assert.deepEqual(state.tag, { annotated: true, commit: COMMIT });
  assert.deepEqual(state.main, candidateMain());
  assert.deepEqual(state.release, remoteRelease(candidate, { isDraft: false }));
  assert.deepEqual(
    classifyRemoteRelease(candidate, state),
    { mode: "complete", releaseCommit: COMMIT },
  );
  assert.ok(calls.every((call) => call.authorization === "Bearer test-token"));
  assert.deepEqual(calls.map((call) => call.pathname).sort(), [...responses.keys()].sort());
});

test("the writer reconstructs, stages, commits, and tags only the reviewed pair", async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "mirafold-release-coordinator-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "checkout");
  const artifact = path.join(temporary, "intake");
  const assets = path.join(temporary, "assets");
  mkdirSync(root);
  mkdirSync(artifact);

  const before = packagePair("1.2.3", "0.3.7", 1);
  const after = packagePair(VERSION, SHELL_VERSION, 2);
  writeFileSync(path.join(root, "package.json"), before.packageText);
  writeFileSync(path.join(root, "package-lock.json"), before.lockText);
  writeFileSync(path.join(root, "README.md"), "unchanged fixture\n");
  git(root, "init", "-b", "main");
  git(root, "add", "--", "package.json", "package-lock.json", "README.md");
  git(
    root,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.com",
    "commit", "-m", "fixture base",
  );
  const baseCommit = git(root, "rev-parse", "HEAD^{commit}");

  writeFileSync(path.join(artifact, "package.json"), after.packageText);
  writeFileSync(path.join(artifact, "package-lock.json"), after.lockText);
  const manifest = {
    schemaVersion: 1,
    package: "mirafold",
    registry: "https://registry.npmjs.org",
    npmVersion: "12.0.2",
    changed: true,
    base: {
      desktopVersion: "1.2.3",
      shellVersion: "0.3.7",
      packageJsonSha256: digest("sha256", before.packageText, "hex"),
      packageLockSha256: digest("sha256", before.lockText, "hex"),
    },
    desktopVersion: VERSION,
    shell: {
      version: SHELL_VERSION,
      tarball: after.tarball,
      integrity: after.integrity,
    },
    source: {
      repository: "https://github.com/mirafold/mirafold",
      ref: `refs/tags/v${SHELL_VERSION}`,
      commit: SOURCE,
      workflow: "/.github/workflows/release.yml",
      builder: "https://github.com/actions/runner/github-hosted",
    },
    files: {
      "package.json": { sha256: digest("sha256", after.packageText, "hex") },
      "package-lock.json": { sha256: digest("sha256", after.lockText, "hex") },
    },
  };
  writeFileSync(path.join(artifact, "shell-intake.json"), jsonText(manifest));
  writeCompleteAssets(assets, VERSION);

  const planFile = path.join(temporary, "plan.json");
  const notesFile = path.join(temporary, "notes.md");
  const outputFile = path.join(temporary, "github-output");
  writeFileSync(outputFile, "");
  const prepared = await prepareReleaseCandidate({
    root,
    artifactDirectory: artifact,
    assetsDirectory: assets,
    baseCommit,
    planFile,
    notesFile,
    githubOutputFile: outputFile,
  });
  assert.equal(prepared.baseCommit, baseCommit);
  assert.equal(prepared.desktopVersion, VERSION);
  assert.equal(prepared.shell.version, SHELL_VERSION);
  assert.deepEqual(git(root, "diff", "--cached", "--name-only").split("\n"), [
    "package-lock.json",
    "package.json",
  ]);
  assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), "unchanged fixture\n");
  assert.deepEqual(JSON.parse(readFileSync(planFile, "utf8")), prepared);
  assert.equal(digest("sha256", readFileSync(notesFile), "hex"), prepared.notesSha256);
  assert.equal(verifyReleaseNotes(prepared, notesFile), prepared.notesSha256);
  writeFileSync(notesFile, `${readFileSync(notesFile, "utf8")}tampered\n`);
  assert.throws(() => verifyReleaseNotes(prepared, notesFile), /notes differ/);
  writeFileSync(notesFile, automatedReleaseNotes(manifest));
  assert.match(readFileSync(outputFile, "utf8"), /tag=v1\.2\.4/);

  // Exactly what the workflow runs: the writer's identity plus `-s`, so the
  // sign-off trailer is produced by git and must match the reviewed message.
  git(
    root,
    "-c", "user.name=github-actions[bot]",
    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "-c", "commit.gpgsign=false",
    "commit", "-s", "-m", prepared.commitMessage.split("\n")[0],
  );
  git(
    root,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.com",
    "-c", "tag.gpgSign=false",
    "tag", "-a", prepared.tag, "-m", prepared.tagMessage,
  );
  const local = verifyLocalReleaseCandidate(prepared, { root });
  assert.equal(local.mode, "push");
  assert.equal(local.releaseCommit, git(root, "rev-parse", "HEAD^{commit}"));
  assert.equal(git(root, "status", "--porcelain=v1"), "");
});
