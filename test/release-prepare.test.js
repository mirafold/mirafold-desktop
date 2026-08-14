import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  PUBLIC_NPM_REGISTRY,
  REQUIRED_NPM_VERSION,
  compareStableVersions,
  lockRefreshArguments,
  nextPatchVersion,
  prepareShellRelease,
} from "../scripts/prepare-shell-release.mjs";

const OLD_SHELL = "0.3.6";
const TARGET_SHELL = "0.3.7";
const NEXT_SHELL = "0.3.8";

function integrity(byte) {
  return `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
}

function tarball(version) {
  return `${PUBLIC_NPM_REGISTRY}/mirafold/-/mirafold-${version}.tgz`;
}

function evidence(version, byte) {
  return { version, integrity: integrity(byte), tarball: tarball(version) };
}

const OLD_EVIDENCE = evidence(OLD_SHELL, 1);
const TARGET_EVIDENCE = evidence(TARGET_SHELL, 2);
const NEXT_EVIDENCE = evidence(NEXT_SHELL, 3);

const repositoryPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture(t, { desktopVersion = "1.2.3", shellVersion = OLD_SHELL, shellIntegrity = OLD_EVIDENCE.integrity } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-release-prepare-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageMetadata = {
    name: "mirafold-desktop-fixture",
    version: desktopVersion,
    private: true,
    scripts: { test: "node --test" },
    dependencies: {
      mirafold: shellVersion,
      unrelated: "1.0.0",
    },
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
        dependencies: { ...packageMetadata.dependencies },
      },
      "node_modules/mirafold": {
        version: shellVersion,
        resolved: tarball(shellVersion),
        integrity: shellIntegrity,
        dependencies: { "shell-child": "1.0.0" },
      },
      "node_modules/shell-child": {
        version: "1.0.0",
        resolved: `${PUBLIC_NPM_REGISTRY}/shell-child/-/shell-child-1.0.0.tgz`,
        integrity: integrity(4),
      },
      "node_modules/unrelated": {
        version: "1.0.0",
        resolved: `${PUBLIC_NPM_REGISTRY}/unrelated/-/unrelated-1.0.0.tgz`,
        integrity: integrity(5),
      },
    },
  };
  writeFileSync(path.join(root, "package.json"), jsonText(packageMetadata));
  writeFileSync(path.join(root, "package-lock.json"), jsonText(lockMetadata));
  return root;
}

function readJson(root, name) {
  return JSON.parse(readFileSync(path.join(root, name), "utf8"));
}

function readPair(root) {
  return {
    packageText: readFileSync(path.join(root, "package.json"), "utf8"),
    lockText: readFileSync(path.join(root, "package-lock.json"), "utf8"),
  };
}

function targetRefresh({ mutate } = {}) {
  return async ({ directory, shellVersion }) => {
    assert.equal(shellVersion, TARGET_SHELL);
    const packageMetadata = readJson(directory, "package.json");
    const lockMetadata = readJson(directory, "package-lock.json");
    lockMetadata.version = packageMetadata.version;
    lockMetadata.packages[""].version = packageMetadata.version;
    lockMetadata.packages[""].dependencies.mirafold = shellVersion;
    lockMetadata.packages["node_modules/mirafold"] = {
      version: shellVersion,
      resolved: TARGET_EVIDENCE.tarball,
      integrity: TARGET_EVIDENCE.integrity,
      dependencies: { "shell-child": "2.0.0" },
    };
    lockMetadata.packages["node_modules/shell-child"] = {
      version: "2.0.0",
      resolved: `${PUBLIC_NPM_REGISTRY}/shell-child/-/shell-child-2.0.0.tgz`,
      integrity: integrity(6),
    };
    mutate?.({ directory, packageMetadata, lockMetadata });
    writeFileSync(path.join(directory, "package.json"), jsonText(packageMetadata));
    writeFileSync(path.join(directory, "package-lock.json"), jsonText(lockMetadata));
  };
}

function querySequence(...items) {
  let calls = 0;
  const query = async () => {
    const item = items[Math.min(calls, items.length - 1)];
    calls += 1;
    return item;
  };
  query.calls = () => calls;
  return query;
}

test("stable version comparison and the independent Desktop patch bump are exact", () => {
  assert.equal(compareStableVersions("0.3.7", "0.3.7"), 0);
  assert.equal(compareStableVersions("0.3.8", "0.3.7"), 1);
  assert.equal(compareStableVersions("10.0.0", "9.9.9"), 1);
  assert.equal(compareStableVersions("0.3.6", "0.3.7"), -1);
  assert.equal(nextPatchVersion("1.2.3"), "1.2.4");
  assert.throws(() => nextPatchVersion("1.2.3-beta.1"), /stable x\.y\.z/);
  assert.throws(() => compareStableVersions("01.2.3", "1.2.3"), /stable x\.y\.z/);
});

test("the real npm lock command is exact, public-registry-only, and script-free", () => {
  assert.deepEqual(lockRefreshArguments(TARGET_SHELL), [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--save-exact",
    "--audit=false",
    "--fund=false",
    "--prefer-online",
    `--registry=${PUBLIC_NPM_REGISTRY}`,
    `mirafold@${TARGET_SHELL}`,
  ]);
});

test("package.json exposes the preparation command through the pinned npm version", () => {
  assert.equal(repositoryPackage.packageManager, `npm@${REQUIRED_NPM_VERSION}`);
  assert.equal(
    repositoryPackage.scripts["release:prepare"],
    "node scripts/prepare-shell-release.mjs",
  );
});

test("one Shell update changes the exact pin, its closure, and one Desktop patch, then becomes a byte no-op", async (t) => {
  const root = fixture(t);
  const query = querySequence(TARGET_EVIDENCE, TARGET_EVIDENCE);
  let refreshCalls = 0;
  const result = await prepareShellRelease({
    root,
    observedVersion: TARGET_SHELL,
    queryLatest: query,
    refreshLock: async (options) => {
      refreshCalls += 1;
      await targetRefresh()(options);
    },
    npmVersion: REQUIRED_NPM_VERSION,
  });

  assert.deepEqual(result, {
    changed: true,
    previousDesktopVersion: "1.2.3",
    desktopVersion: "1.2.4",
    previousShellVersion: OLD_SHELL,
    shellVersion: TARGET_SHELL,
    integrity: TARGET_EVIDENCE.integrity,
  });
  assert.equal(query.calls(), 2, "latest must be checked on both sides of lock generation");
  assert.equal(refreshCalls, 1);
  const packageMetadata = readJson(root, "package.json");
  const lockMetadata = readJson(root, "package-lock.json");
  assert.equal(packageMetadata.version, "1.2.4");
  assert.equal(packageMetadata.dependencies.mirafold, TARGET_SHELL);
  assert.equal(lockMetadata.version, "1.2.4");
  assert.equal(lockMetadata.packages[""].dependencies.mirafold, TARGET_SHELL);
  assert.equal(lockMetadata.packages["node_modules/mirafold"].integrity, TARGET_EVIDENCE.integrity);
  assert.equal(lockMetadata.packages["node_modules/shell-child"].version, "2.0.0");
  assert.equal(lockMetadata.packages["node_modules/unrelated"].version, "1.0.0");

  const beforeNoOp = readPair(root);
  const noOp = await prepareShellRelease({
    root,
    observedVersion: TARGET_SHELL,
    queryLatest: async () => TARGET_EVIDENCE,
    refreshLock: async () => assert.fail("current releases must not regenerate the lock"),
    npmVersion: REQUIRED_NPM_VERSION,
  });
  assert.equal(noOp.changed, false);
  assert.equal(noOp.desktopVersion, "1.2.4");
  assert.deepEqual(readPair(root), beforeNoOp, "idempotent rerun must not rewrite either file");
});

test("a stale observed version is refused before lock generation", async (t) => {
  const root = fixture(t);
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: async () => NEXT_EVIDENCE,
      refreshLock: async () => assert.fail("stale input must not regenerate the lock"),
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /is not npm latest/,
  );
  assert.deepEqual(readPair(root), before);
});

test("a registry rollback below the pinned Shell is refused", async (t) => {
  const root = fixture(t, {
    shellVersion: TARGET_SHELL,
    shellIntegrity: TARGET_EVIDENCE.integrity,
  });
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: OLD_SHELL,
      queryLatest: async () => OLD_EVIDENCE,
      refreshLock: async () => assert.fail("downgrades must not regenerate the lock"),
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /older than pinned/,
  );
  assert.deepEqual(readPair(root), before);
});

test("non-exact current pins are invalid state, not something preparation silently fixes", async (t) => {
  const root = fixture(t);
  const packageMetadata = readJson(root, "package.json");
  packageMetadata.dependencies.mirafold = `^${OLD_SHELL}`;
  writeFileSync(path.join(root, "package.json"), jsonText(packageMetadata));
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: async () => assert.fail("invalid local state must fail before network evidence"),
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /stable x\.y\.z/,
  );
  assert.deepEqual(readPair(root), before);
});

test("semantic lockfile churn outside Mirafold's dependency closure aborts without writes", async (t) => {
  const root = fixture(t);
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: querySequence(TARGET_EVIDENCE, TARGET_EVIDENCE),
      refreshLock: targetRefresh({
        mutate: ({ lockMetadata }) => {
          lockMetadata.packages["node_modules/unrelated"].version = "9.9.9";
        },
      }),
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /unrelated lock entry node_modules\/unrelated/,
  );
  assert.deepEqual(readPair(root), before);
});

test("changing npm latest evidence during preparation aborts without writes", async (t) => {
  const root = fixture(t);
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: querySequence(TARGET_EVIDENCE, NEXT_EVIDENCE),
      refreshLock: targetRefresh(),
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /is not npm latest/,
  );
  assert.deepEqual(readPair(root), before);
});

test("a generated target whose integrity differs from npm evidence is refused", async (t) => {
  const root = fixture(t);
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: querySequence(TARGET_EVIDENCE, TARGET_EVIDENCE),
      refreshLock: targetRefresh({
        mutate: ({ lockMetadata }) => {
          lockMetadata.packages["node_modules/mirafold"].integrity = integrity(9);
        },
      }),
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /integrity differs from npm latest evidence/,
  );
  assert.deepEqual(readPair(root), before);
});

test("a current pin with different bytes is not accepted as an idempotent release", async (t) => {
  const root = fixture(t, {
    shellVersion: TARGET_SHELL,
    shellIntegrity: integrity(9),
  });
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: async () => TARGET_EVIDENCE,
      refreshLock: async () => assert.fail("an apparent no-op must not regenerate the lock"),
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /current Mirafold lock integrity differs from npm latest evidence/,
  );
  assert.deepEqual(readPair(root), before);
});

test("the exact npm version is part of deterministic preparation", async (t) => {
  const root = fixture(t);
  const before = readPair(root);
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: async () => assert.fail("wrong npm version must fail before network evidence"),
      npmVersion: "11.0.0",
    }),
    new RegExp(`requires npm ${REQUIRED_NPM_VERSION.replaceAll(".", "\\.")}`),
  );
  assert.deepEqual(readPair(root), before);
});

test("a concurrent source edit is preserved and prevents the prepared pair from committing", async (t) => {
  const root = fixture(t);
  const packageFile = path.join(root, "package.json");
  const originalLock = readFileSync(path.join(root, "package-lock.json"), "utf8");
  const concurrentPackage = { ...readJson(root, "package.json"), concurrentEdit: true };
  await assert.rejects(
    prepareShellRelease({
      root,
      observedVersion: TARGET_SHELL,
      queryLatest: querySequence(TARGET_EVIDENCE, TARGET_EVIDENCE),
      refreshLock: async (options) => {
        await targetRefresh()(options);
        writeFileSync(packageFile, jsonText(concurrentPackage));
      },
      npmVersion: REQUIRED_NPM_VERSION,
    }),
    /package\.json changed during preparation/,
  );
  assert.deepEqual(readJson(root, "package.json"), concurrentPackage);
  assert.equal(readFileSync(path.join(root, "package-lock.json"), "utf8"), originalLock);
});
