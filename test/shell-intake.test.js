import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  GITHUB_HOSTED_BUILDER,
  GITHUB_WORKFLOW_BUILD_TYPE,
  INTAKE_SCHEMA_VERSION,
  SHELL_SOURCE_REPOSITORY,
  SHELL_SOURCE_WORKFLOW,
  SLSA_PROVENANCE_TYPE,
  applyIntakeArtifact,
  checkAppliedIntake,
  prepareIntake,
  readIntakeArtifact,
  verifyAndStageIntake,
  verifyMirafoldProvenance,
} from "../scripts/shell-intake.mjs";
import {
  PUBLIC_NPM_REGISTRY,
  REQUIRED_NPM_VERSION,
} from "../scripts/prepare-shell-release.mjs";

const BASE_DESKTOP = "1.2.3";
const TARGET_DESKTOP = "1.2.4";
const BASE_SHELL = "0.3.6";
const TARGET_SHELL = "0.3.7";
const SOURCE_COMMIT = "1723a2d6f5f2d08159d1acf7c5d496d3420882d9";

function integrity(byte) {
  return `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
}

function tarball(version) {
  return `${PUBLIC_NPM_REGISTRY}/mirafold/-/mirafold-${version}.tgz`;
}

const BASE_EVIDENCE = {
  version: BASE_SHELL,
  integrity: integrity(1),
  tarball: tarball(BASE_SHELL),
};
const TARGET_EVIDENCE = {
  version: TARGET_SHELL,
  integrity: integrity(2),
  tarball: tarball(TARGET_SHELL),
};

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryDirectory(t, prefix = "mirafold-shell-intake-test-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function pairValues({ desktopVersion, shellVersion, shellIntegrity }) {
  const packageMetadata = {
    name: "mirafold-desktop-fixture",
    version: desktopVersion,
    private: true,
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
      },
      "node_modules/unrelated": {
        version: "1.0.0",
        resolved: `${PUBLIC_NPM_REGISTRY}/unrelated/-/unrelated-1.0.0.tgz`,
        integrity: integrity(9),
      },
    },
  };
  return {
    packageText: jsonText(packageMetadata),
    lockText: jsonText(lockMetadata),
  };
}

const BASE_PAIR = pairValues({
  desktopVersion: BASE_DESKTOP,
  shellVersion: BASE_SHELL,
  shellIntegrity: BASE_EVIDENCE.integrity,
});
const TARGET_PAIR = pairValues({
  desktopVersion: TARGET_DESKTOP,
  shellVersion: TARGET_SHELL,
  shellIntegrity: TARGET_EVIDENCE.integrity,
});

function writePair(root, pair) {
  writeFileSync(path.join(root, "package.json"), pair.packageText);
  writeFileSync(path.join(root, "package-lock.json"), pair.lockText);
}

function statementFixture({ mutate } = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/mirafold@${TARGET_SHELL}`,
        digest: {
          sha512: Buffer.from(TARGET_EVIDENCE.integrity.slice("sha512-".length), "base64").toString("hex"),
        },
      },
    ],
    predicateType: SLSA_PROVENANCE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: GITHUB_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: {
            ref: `refs/tags/v${TARGET_SHELL}`,
            repository: SHELL_SOURCE_REPOSITORY,
            path: SHELL_SOURCE_WORKFLOW,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${SHELL_SOURCE_REPOSITORY}@refs/tags/v${TARGET_SHELL}`,
            digest: { gitCommit: SOURCE_COMMIT },
          },
        ],
      },
      runDetails: {
        builder: { id: GITHUB_HOSTED_BUILDER },
      },
    },
  };
  mutate?.(statement);
  return statement;
}

function auditFixture({ mutateStatement, mutateEntry, mutateAudit } = {}) {
  const statement = statementFixture({ mutate: mutateStatement });
  const entry = {
    name: "mirafold",
    version: TARGET_SHELL,
    location: "node_modules/mirafold",
    // npm 12 preserves the workflow's configured spelling (no trailing slash).
    registry: PUBLIC_NPM_REGISTRY,
    attestations: {
      provenance: { predicateType: SLSA_PROVENANCE_TYPE },
    },
    attestationBundles: [
      {
        predicateType: SLSA_PROVENANCE_TYPE,
        bundle: {
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            payloadType: "application/vnd.in-toto+json",
            signatures: [{ sig: "npm-has-already-verified-this", keyid: "" }],
          },
        },
      },
    ],
  };
  mutateEntry?.(entry);
  const audit = { invalid: [], missing: [], verified: [entry] };
  mutateAudit?.(audit, entry);
  return audit;
}

async function createChangedState(t) {
  const root = temporaryDirectory(t);
  const stateFile = path.join(root, "intake-state.json");
  const githubOutputFile = path.join(root, "github-output");
  writePair(root, BASE_PAIR);
  writeFileSync(githubOutputFile, "");
  const state = await prepareIntake({
    root,
    stateFile,
    githubOutputFile,
    queryLatest: async () => TARGET_EVIDENCE,
    prepare: async ({ root: preparationRoot, observedVersion }) => {
      assert.equal(observedVersion, TARGET_SHELL);
      writePair(preparationRoot, TARGET_PAIR);
      return {
        changed: true,
        previousDesktopVersion: BASE_DESKTOP,
        desktopVersion: TARGET_DESKTOP,
        previousShellVersion: BASE_SHELL,
        shellVersion: TARGET_SHELL,
        integrity: TARGET_EVIDENCE.integrity,
      };
    },
  });
  return { root, stateFile, githubOutputFile, state };
}

test("preparation records the exact checkout transition and GitHub outputs outside the source pair", async (t) => {
  const { root, stateFile, githubOutputFile, state } = await createChangedState(t);
  assert.equal(state.schemaVersion, INTAKE_SCHEMA_VERSION);
  assert.equal(state.npmVersion, REQUIRED_NPM_VERSION);
  assert.deepEqual(state.observed, TARGET_EVIDENCE);
  assert.deepEqual(state.base, {
    desktopVersion: BASE_DESKTOP,
    shellVersion: BASE_SHELL,
    packageJsonSha256: sha256(BASE_PAIR.packageText),
    packageLockSha256: sha256(BASE_PAIR.lockText),
  });
  assert.deepEqual(state.preparation, {
    changed: true,
    desktopVersion: TARGET_DESKTOP,
    shellVersion: TARGET_SHELL,
    packageJsonSha256: sha256(TARGET_PAIR.packageText),
    packageLockSha256: sha256(TARGET_PAIR.lockText),
  });
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), state);
  assert.equal(
    readFileSync(githubOutputFile, "utf8"),
    `changed=true\ndesktop-version=${TARGET_DESKTOP}\nshell-version=${TARGET_SHELL}\n`,
  );
  assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), TARGET_PAIR.packageText);
  assert.equal(readFileSync(path.join(root, "package-lock.json"), "utf8"), TARGET_PAIR.lockText);
});

test("a no-update observation stays byte-identical and cannot produce a downstream artifact", async (t) => {
  const root = temporaryDirectory(t);
  const stateFile = path.join(root, "intake-state.json");
  const auditFile = path.join(root, "audit.json");
  const outputDirectory = path.join(root, "artifact");
  writePair(root, BASE_PAIR);
  const state = await prepareIntake({
    root,
    stateFile,
    queryLatest: async () => BASE_EVIDENCE,
    prepare: async () => ({
      changed: false,
      desktopVersion: BASE_DESKTOP,
      shellVersion: BASE_SHELL,
      integrity: BASE_EVIDENCE.integrity,
    }),
  });
  writeFileSync(auditFile, jsonText(auditFixture()));
  assert.equal(state.preparation.changed, false);
  assert.equal(state.base.packageJsonSha256, state.preparation.packageJsonSha256);
  assert.equal(state.base.packageLockSha256, state.preparation.packageLockSha256);
  assert.throws(
    () => verifyAndStageIntake({ root, stateFile, auditFile, outputDirectory }),
    /no-op intake must not create a downstream artifact/,
  );
  assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), BASE_PAIR.packageText);
});

test("verified npm evidence is reduced to one exact immutable-candidate artifact", async (t) => {
  const { root, stateFile, githubOutputFile } = await createChangedState(t);
  const auditFile = path.join(root, "audit.json");
  const outputDirectory = path.join(root, "artifact");
  writeFileSync(auditFile, jsonText(auditFixture()));
  const manifest = verifyAndStageIntake({
    root,
    stateFile,
    auditFile,
    outputDirectory,
    githubOutputFile,
  });

  assert.deepEqual(readdirSync(outputDirectory).sort(), [
    "package-lock.json",
    "package.json",
    "shell-intake.json",
  ]);
  assert.equal(manifest.changed, true);
  assert.equal(manifest.desktopVersion, TARGET_DESKTOP);
  assert.deepEqual(manifest.shell, TARGET_EVIDENCE);
  assert.deepEqual(manifest.source, {
    repository: SHELL_SOURCE_REPOSITORY,
    ref: `refs/tags/v${TARGET_SHELL}`,
    commit: SOURCE_COMMIT,
    workflow: SHELL_SOURCE_WORKFLOW,
    builder: GITHUB_HOSTED_BUILDER,
  });
  assert.deepEqual(manifest.files, {
    "package.json": { sha256: sha256(TARGET_PAIR.packageText) },
    "package-lock.json": { sha256: sha256(TARGET_PAIR.lockText) },
  });
  assert.deepEqual(readIntakeArtifact(outputDirectory).manifest, manifest);
  assert.equal(
    readFileSync(githubOutputFile, "utf8"),
    [
      `changed=true`,
      `desktop-version=${TARGET_DESKTOP}`,
      `shell-version=${TARGET_SHELL}`,
      `source-commit=${SOURCE_COMMIT}`,
      `package-json-sha256=${sha256(TARGET_PAIR.packageText)}`,
      `package-lock-sha256=${sha256(TARGET_PAIR.lockText)}`,
      "",
    ].join("\n"),
  );
});

test("the source policy binds package bytes to Mirafold's tagged GitHub release workflow", () => {
  assert.equal(SHELL_SOURCE_WORKFLOW, ".github/workflows/release.yml");
  assert.deepEqual(verifyMirafoldProvenance(auditFixture(), TARGET_EVIDENCE), {
    repository: SHELL_SOURCE_REPOSITORY,
    ref: `refs/tags/v${TARGET_SHELL}`,
    commit: SOURCE_COMMIT,
    workflow: SHELL_SOURCE_WORKFLOW,
    builder: GITHUB_HOSTED_BUILDER,
  });
});

test("the source policy accepts npm's equivalent trailing-slash registry spelling", () => {
  const audit = auditFixture({
    mutateEntry: (entry) => { entry.registry = `${PUBLIC_NPM_REGISTRY}/`; },
  });
  assert.equal(verifyMirafoldProvenance(audit, TARGET_EVIDENCE).commit, SOURCE_COMMIT);
});

test("the source policy refuses signature gaps and every material provenance substitution", async (t) => {
  const cases = [
    {
      name: "missing signatures",
      audit: auditFixture({ mutateAudit: (audit) => audit.missing.push({ name: "dependency" }) }),
      pattern: /missing package signatures/,
    },
    {
      name: "invalid attestations",
      audit: auditFixture({ mutateAudit: (audit) => audit.invalid.push({ name: "dependency" }) }),
      pattern: /invalid package signatures/,
    },
    {
      name: "ambiguous package entry",
      audit: auditFixture({ mutateAudit: (audit, entry) => audit.verified.push(structuredClone(entry)) }),
      pattern: /2 Mirafold entries/,
    },
    {
      name: "different registry",
      audit: auditFixture({ mutateEntry: (entry) => { entry.registry = "https://registry.example.com"; } }),
      pattern: /verified Mirafold registry differs/,
    },
    {
      name: "different subject bytes",
      audit: auditFixture({ mutateStatement: (statement) => { statement.subject[0].digest.sha512 = "0".repeat(128); } }),
      pattern: /statement digest differs/,
    },
    {
      name: "different repository",
      audit: auditFixture({ mutateStatement: (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/attacker/mirafold"; } }),
      pattern: /source repository differs/,
    },
    {
      name: "branch instead of release tag",
      audit: auditFixture({ mutateStatement: (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"; } }),
      pattern: /source ref differs/,
    },
    {
      name: "different workflow",
      audit: auditFixture({ mutateStatement: (statement) => { statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; } }),
      pattern: /workflow path differs/,
    },
    {
      name: "different source record",
      audit: auditFixture({ mutateStatement: (statement) => { statement.predicate.buildDefinition.resolvedDependencies[0].uri = "git+https://github.com/attacker/mirafold@refs/tags/v0.3.7"; } }),
      pattern: /0 exact source records/,
    },
    {
      name: "invalid commit",
      audit: auditFixture({ mutateStatement: (statement) => { statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "not-a-commit"; } }),
      pattern: /source commit is invalid/,
    },
    {
      name: "self-hosted builder",
      audit: auditFixture({ mutateStatement: (statement) => { statement.predicate.runDetails.builder.id = "https://example.com/self-hosted"; } }),
      pattern: /builder is not GitHub-hosted/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      assert.throws(() => verifyMirafoldProvenance(item.audit, TARGET_EVIDENCE), item.pattern);
    });
  }
});

test("a consumer applies only an artifact for its byte-exact package/lock baseline and detects later mutation", async (t) => {
  const producer = await createChangedState(t);
  const auditFile = path.join(producer.root, "audit.json");
  const artifactDirectory = path.join(producer.root, "artifact");
  writeFileSync(auditFile, jsonText(auditFixture()));
  verifyAndStageIntake({
    root: producer.root,
    stateFile: producer.stateFile,
    auditFile,
    outputDirectory: artifactDirectory,
  });

  const consumer = temporaryDirectory(t, "mirafold-shell-intake-consumer-");
  writePair(consumer, BASE_PAIR);
  const manifest = applyIntakeArtifact({ root: consumer, artifactDirectory });
  assert.equal(manifest.desktopVersion, TARGET_DESKTOP);
  assert.equal(readFileSync(path.join(consumer, "package.json"), "utf8"), TARGET_PAIR.packageText);
  assert.equal(readFileSync(path.join(consumer, "package-lock.json"), "utf8"), TARGET_PAIR.lockText);
  assert.equal(checkAppliedIntake({ root: consumer, artifactDirectory }).source.commit, SOURCE_COMMIT);

  const changedPackage = `${TARGET_PAIR.packageText}\n`;
  writeFileSync(path.join(consumer, "package.json"), changedPackage);
  assert.throws(
    () => checkAppliedIntake({ root: consumer, artifactDirectory }),
    /applied package\.json changed after intake/,
  );
});

test("an artifact for another checkout is refused without changing either consumer file", async (t) => {
  const producer = await createChangedState(t);
  const auditFile = path.join(producer.root, "audit.json");
  const artifactDirectory = path.join(producer.root, "artifact");
  writeFileSync(auditFile, jsonText(auditFixture()));
  verifyAndStageIntake({
    root: producer.root,
    stateFile: producer.stateFile,
    auditFile,
    outputDirectory: artifactDirectory,
  });

  const consumer = temporaryDirectory(t, "mirafold-shell-intake-stale-consumer-");
  const differentBase = {
    packageText: BASE_PAIR.packageText.replace('"private": true,', '"private": true,\n  "different": true,'),
    lockText: BASE_PAIR.lockText,
  };
  writePair(consumer, differentBase);
  const beforePackage = readFileSync(path.join(consumer, "package.json"), "utf8");
  const beforeLock = readFileSync(path.join(consumer, "package-lock.json"), "utf8");
  assert.throws(
    () => applyIntakeArtifact({ root: consumer, artifactDirectory }),
    /consumer package\.json differs from intake base/,
  );
  assert.equal(readFileSync(path.join(consumer, "package.json"), "utf8"), beforePackage);
  assert.equal(readFileSync(path.join(consumer, "package-lock.json"), "utf8"), beforeLock);
});

test("artifact readers refuse extra files and manifest hash tampering", async (t) => {
  const producer = await createChangedState(t);
  const auditFile = path.join(producer.root, "audit.json");
  const artifactDirectory = path.join(producer.root, "artifact");
  writeFileSync(auditFile, jsonText(auditFixture()));
  verifyAndStageIntake({
    root: producer.root,
    stateFile: producer.stateFile,
    auditFile,
    outputDirectory: artifactDirectory,
  });

  writeFileSync(path.join(artifactDirectory, "unexpected.txt"), "not reviewed\n");
  assert.throws(() => readIntakeArtifact(artifactDirectory), /artifact files differ/);
  rmSync(path.join(artifactDirectory, "unexpected.txt"));

  const manifestFile = path.join(artifactDirectory, "shell-intake.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.files["package.json"].sha256 = "0".repeat(64);
  writeFileSync(manifestFile, jsonText(manifest));
  assert.throws(() => readIntakeArtifact(artifactDirectory), /package hash differs/);
});
