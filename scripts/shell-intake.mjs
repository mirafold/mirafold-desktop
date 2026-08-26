#!/usr/bin/env node

// Read-only Shell intake boundary.
//
// `prepare` observes npm's current Mirafold `latest`, delegates the guarded
// package/lock update to prepare-shell-release.mjs, and records the exact before
// and after bytes outside the checkout. No installed dependency code runs.
//
// After `npm ci --ignore-scripts` and a successful
// `npm audit signatures --json --include-attestations`, `verify` enforces this
// project's source policy over npm's already-cryptographically-verified SLSA
// statement. It emits an immutable-candidate directory containing only the
// reviewed package.json, package-lock.json, and a compact evidence manifest.
//
// Later jobs use `apply` to prove that artifact belongs to their checkout's
// exact package/lock baseline before installing or running dependencies.
// `check` proves dependency/test execution did not alter either reviewed
// manifest. GitHub Actions separately fixes every job to the run's github.sha.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_NPM_REGISTRY,
  REQUIRED_NPM_VERSION,
  compareStableVersions,
  commitPreparedFiles,
  fetchLatestShellEvidence,
  nextPatchVersion,
  prepareShellRelease,
} from "./prepare-shell-release.mjs";

export const INTAKE_SCHEMA_VERSION = 1;
export const SHELL_PACKAGE = "mirafold";
export const SHELL_SOURCE_REPOSITORY = "https://github.com/mirafold/mirafold";
export const SHELL_SOURCE_WORKFLOW = ".github/workflows/release.yml";
export const SLSA_PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
export const GITHUB_WORKFLOW_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
export const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const PACKAGE_LIMIT = 1024 * 1024;
const LOCK_LIMIT = 32 * 1024 * 1024;
const STATE_LIMIT = 1024 * 1024;
const AUDIT_LIMIT = 128 * 1024 * 1024;
const ARTIFACT_FILES = ["package-lock.json", "package.json", "shell-intake.json"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function stableVersion(value, label) {
  invariant(typeof value === "string" && STABLE_VERSION.test(value), `${label} must be a stable x.y.z version`);
  return value;
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} keys differ; expected [${wanted.join(", ")}], found [${actual.join(", ")}]`,
  );
}

function validateIntakeIdentity(value, label) {
  invariant(value.schemaVersion === INTAKE_SCHEMA_VERSION, `${label} schema is unsupported`);
  invariant(value.package === SHELL_PACKAGE, `${label} package differs`);
  invariant(value.registry === PUBLIC_NPM_REGISTRY, `${label} registry differs`);
  invariant(value.npmVersion === REQUIRED_NPM_VERSION, `${label} npm version differs`);
}

function validateBaseRecord(value, label) {
  exactKeys(
    value,
    ["desktopVersion", "shellVersion", "packageJsonSha256", "packageLockSha256"],
    label,
  );
  stableVersion(value.desktopVersion, `${label} Desktop version`);
  stableVersion(value.shellVersion, `${label} Shell version`);
  invariant(SHA256_HEX.test(value.packageJsonSha256), `${label} package hash is invalid`);
  invariant(SHA256_HEX.test(value.packageLockSha256), `${label} lock hash is invalid`);
}

function readRegularText(file, label, maximumBytes) {
  const record = lstatSync(file);
  invariant(record.isFile(), `${label} must be a regular file`);
  invariant(record.size <= maximumBytes, `${label} exceeds ${maximumBytes} bytes`);
  return readFileSync(file, "utf8");
}

function parseJsonText(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must contain an object`);
  return value;
}

function readJson(file, label, maximumBytes) {
  return parseJsonText(readRegularText(file, label, maximumBytes), label);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value, label) {
  invariant(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value), `${label} is not base64`);
  const bytes = Buffer.from(value, "base64");
  invariant(bytes.length > 0 && bytes.toString("base64") === value, `${label} is not canonical base64`);
  return bytes;
}

function canonicalIntegrity(value, label) {
  invariant(typeof value === "string" && value.startsWith("sha512-"), `${label} is not SHA-512 integrity`);
  const bytes = canonicalBase64(value.slice("sha512-".length), label);
  invariant(bytes.length === 64, `${label} is not a 64-byte SHA-512`);
  return value;
}

function shellTarball(version) {
  return `${PUBLIC_NPM_REGISTRY}/${SHELL_PACKAGE}/-/${SHELL_PACKAGE}-${version}.tgz`;
}

function normalizeEvidence(value, label = "Shell registry evidence") {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} is missing`);
  const version = stableVersion(value.version, `${label} version`);
  const integrity = canonicalIntegrity(value.integrity, `${label} integrity`);
  const tarball = value.tarball;
  invariant(tarball === shellTarball(version), `${label} tarball is not the fixed public-registry URL`);
  return { version, integrity, tarball };
}

function validatePairTexts(packageText, lockText, label = "prepared source") {
  const packageMetadata = parseJsonText(packageText, `${label} package.json`);
  const lockMetadata = parseJsonText(lockText, `${label} package-lock.json`);
  invariant(typeof packageMetadata.name === "string" && packageMetadata.name.length > 0, `${label} has no package name`);
  const desktopVersion = stableVersion(packageMetadata.version, `${label} Desktop version`);
  const shellVersion = stableVersion(packageMetadata?.dependencies?.mirafold, `${label} Shell dependency`);
  invariant(lockMetadata.lockfileVersion === 3, `${label} lockfileVersion must be 3`);
  invariant(lockMetadata.name === packageMetadata.name, `${label} package and lock names differ`);
  invariant(lockMetadata.version === desktopVersion, `${label} package and lock Desktop versions differ`);
  const root = lockMetadata?.packages?.[""];
  invariant(root && typeof root === "object", `${label} lock has no root package record`);
  invariant(root.name === packageMetadata.name, `${label} lock root name differs`);
  invariant(root.version === desktopVersion, `${label} lock root Desktop version differs`);
  invariant(root?.dependencies?.mirafold === shellVersion, `${label} package and lock root Shell versions differ`);
  const shell = lockMetadata?.packages?.[`node_modules/${SHELL_PACKAGE}`];
  invariant(shell && typeof shell === "object", `${label} lock has no Mirafold record`);
  invariant(shell.version === shellVersion, `${label} lock Shell record differs from the exact pin`);
  invariant(shell.resolved === shellTarball(shellVersion), `${label} Shell is not resolved from the public registry`);
  canonicalIntegrity(shell.integrity, `${label} Shell integrity`);
  return {
    packageText,
    lockText,
    packageMetadata,
    lockMetadata,
    packageName: packageMetadata.name,
    desktopVersion,
    shellVersion,
    shellIntegrity: shell.integrity,
    shellTarball: shell.resolved,
    packageJsonSha256: sha256(packageText),
    packageLockSha256: sha256(lockText),
  };
}

function readPair(root, label = "checkout") {
  const packageText = readRegularText(path.join(root, "package.json"), `${label} package.json`, PACKAGE_LIMIT);
  const lockText = readRegularText(path.join(root, "package-lock.json"), `${label} package-lock.json`, LOCK_LIMIT);
  return validatePairTexts(packageText, lockText, label);
}

function validatePreparationResult(result, before, after, evidence) {
  invariant(result && typeof result === "object" && !Array.isArray(result), "release preparation returned no result");
  invariant(typeof result.changed === "boolean", "release preparation has no changed boolean");
  invariant(result.desktopVersion === after.desktopVersion, "prepared Desktop version differs from preparation result");
  invariant(result.shellVersion === after.shellVersion, "prepared Shell version differs from preparation result");
  invariant(result.integrity === evidence.integrity, "preparation result integrity differs from observed latest");
  invariant(after.shellVersion === evidence.version, "prepared Shell version differs from observed latest");
  invariant(after.shellIntegrity === evidence.integrity, "prepared lock integrity differs from observed latest");
  invariant(after.shellTarball === evidence.tarball, "prepared lock tarball differs from observed latest");

  if (result.changed) {
    invariant(result.previousDesktopVersion === before.desktopVersion, "previous Desktop version differs from checkout");
    invariant(result.previousShellVersion === before.shellVersion, "previous Shell version differs from checkout");
    invariant(after.desktopVersion === nextPatchVersion(before.desktopVersion), "prepared Desktop version is not one patch above the checkout");
    invariant(compareStableVersions(after.shellVersion, before.shellVersion) > 0, "prepared Shell version did not advance");
  } else {
    invariant(after.packageJsonSha256 === before.packageJsonSha256, "no-op preparation changed package.json");
    invariant(after.packageLockSha256 === before.packageLockSha256, "no-op preparation changed package-lock.json");
  }
}

function writeExclusiveJson(file, value, label) {
  invariant(!existsSync(file), `${label} already exists`);
  writeFileSync(file, jsonText(value), { flag: "wx", mode: 0o600 });
}

// Keep this small adapter local: Shell intake's one repository-owned import is
// an explicit trust boundary, and sharing it does not justify widening that.
function appendGithubOutputs(file, entries) {
  if (file === undefined || file === null) return;
  invariant(typeof file === "string" && file.length > 0, "GitHub output path is invalid");
  invariant(lstatSync(file).isFile(), "GitHub output path must be a regular file");
  const lines = Object.entries(entries).map(([key, value]) => {
    invariant(/^[a-z][a-z0-9-]*$/.test(key), `invalid GitHub output name ${key}`);
    invariant(typeof value === "string" && !value.includes("\n") && !value.includes("\r"), `invalid GitHub output ${key}`);
    return `${key}=${value}`;
  });
  appendFileSync(file, `${lines.join("\n")}\n`);
}

export async function prepareIntake({
  root = ROOT,
  stateFile,
  githubOutputFile,
  queryLatest = fetchLatestShellEvidence,
  prepare = prepareShellRelease,
} = {}) {
  invariant(typeof stateFile === "string" && stateFile.length > 0, "prepare requires a state-file path");
  const before = readPair(root, "source checkout");
  const evidence = normalizeEvidence(await queryLatest());
  const result = await prepare({ root, observedVersion: evidence.version });
  const after = readPair(root, "prepared checkout");
  validatePreparationResult(result, before, after, evidence);

  const state = {
    schemaVersion: INTAKE_SCHEMA_VERSION,
    package: SHELL_PACKAGE,
    registry: PUBLIC_NPM_REGISTRY,
    npmVersion: REQUIRED_NPM_VERSION,
    observed: evidence,
    base: {
      desktopVersion: before.desktopVersion,
      shellVersion: before.shellVersion,
      packageJsonSha256: before.packageJsonSha256,
      packageLockSha256: before.packageLockSha256,
    },
    preparation: {
      changed: result.changed,
      desktopVersion: after.desktopVersion,
      shellVersion: after.shellVersion,
      packageJsonSha256: after.packageJsonSha256,
      packageLockSha256: after.packageLockSha256,
    },
  };
  writeExclusiveJson(stateFile, state, "intake state file");
  appendGithubOutputs(githubOutputFile, {
    changed: String(result.changed),
    "desktop-version": after.desktopVersion,
    "shell-version": after.shellVersion,
  });
  return state;
}

function validateState(value, pair) {
  exactKeys(
    value,
    ["schemaVersion", "package", "registry", "npmVersion", "observed", "base", "preparation"],
    "intake state",
  );
  validateIntakeIdentity(value, "intake state");
  const observed = normalizeEvidence(value.observed, "intake state observation");
  validateBaseRecord(value.base, "intake base");

  exactKeys(
    value.preparation,
    ["changed", "desktopVersion", "shellVersion", "packageJsonSha256", "packageLockSha256"],
    "intake preparation",
  );
  invariant(typeof value.preparation.changed === "boolean", "intake preparation changed value is invalid");
  stableVersion(value.preparation.desktopVersion, "intake prepared Desktop version");
  stableVersion(value.preparation.shellVersion, "intake prepared Shell version");
  invariant(SHA256_HEX.test(value.preparation.packageJsonSha256), "intake prepared package hash is invalid");
  invariant(SHA256_HEX.test(value.preparation.packageLockSha256), "intake prepared lock hash is invalid");
  invariant(pair.desktopVersion === value.preparation.desktopVersion, "checkout Desktop version differs from intake state");
  invariant(pair.shellVersion === value.preparation.shellVersion, "checkout Shell version differs from intake state");
  invariant(pair.packageJsonSha256 === value.preparation.packageJsonSha256, "checkout package.json differs from intake state");
  invariant(pair.packageLockSha256 === value.preparation.packageLockSha256, "checkout package-lock.json differs from intake state");
  invariant(pair.shellVersion === observed.version, "checkout Shell version differs from observed latest");
  invariant(pair.shellIntegrity === observed.integrity, "checkout Shell integrity differs from observed latest");
  invariant(pair.shellTarball === observed.tarball, "checkout Shell tarball differs from observed latest");
  return observed;
}

function decodeStatement(bundle) {
  invariant(bundle && typeof bundle === "object", "Mirafold SLSA bundle is missing");
  const envelope = bundle?.bundle?.dsseEnvelope;
  invariant(envelope && typeof envelope === "object", "Mirafold SLSA bundle has no DSSE envelope");
  invariant(envelope.payloadType === "application/vnd.in-toto+json", "Mirafold DSSE payload type differs");
  invariant(Array.isArray(envelope.signatures) && envelope.signatures.length > 0, "Mirafold DSSE envelope has no signature");
  const payload = canonicalBase64(envelope.payload, "Mirafold DSSE payload").toString("utf8");
  return parseJsonText(payload, "Mirafold SLSA statement");
}

function verifiedShellEntry(audit, evidence) {
  invariant(audit && typeof audit === "object" && !Array.isArray(audit), "npm signature report is missing");
  invariant(Array.isArray(audit.invalid) && audit.invalid.length === 0, "npm reported invalid package signatures or attestations");
  invariant(Array.isArray(audit.missing) && audit.missing.length === 0, "npm reported missing package signatures or attestations");
  invariant(Array.isArray(audit.verified), "npm signature report has no verified array");
  const matches = audit.verified.filter((entry) => entry?.name === SHELL_PACKAGE);
  invariant(matches.length === 1, `npm signature report contains ${matches.length} Mirafold entries`);
  const entry = matches[0];
  invariant(entry.version === evidence.version, "verified Mirafold version differs from observed latest");
  invariant(entry.location === `node_modules/${SHELL_PACKAGE}`, "verified Mirafold install location differs");
  // npm copies the configured registry spelling into this report verbatim.
  // Accept only the two equivalent spellings of the fixed public registry;
  // the workflow currently emits the form without a trailing slash.
  invariant(
    entry.registry === PUBLIC_NPM_REGISTRY || entry.registry === `${PUBLIC_NPM_REGISTRY}/`,
    "verified Mirafold registry differs",
  );
  return entry;
}

function verifiedProvenanceStatement(entry) {
  invariant(entry?.attestations?.provenance?.predicateType === SLSA_PROVENANCE_TYPE, "Mirafold has no verified SLSA v1 provenance");
  invariant(Array.isArray(entry.attestationBundles), "Mirafold has no verified attestation bundles");
  const bundles = entry.attestationBundles.filter((bundle) => bundle?.predicateType === SLSA_PROVENANCE_TYPE);
  invariant(bundles.length === 1, `Mirafold has ${bundles.length} SLSA v1 provenance bundles`);
  return decodeStatement(bundles[0]);
}

function validateProvenanceSubject(statement, evidence) {
  invariant(statement._type === "https://in-toto.io/Statement/v1", "Mirafold statement type differs");
  invariant(statement.predicateType === SLSA_PROVENANCE_TYPE, "Mirafold statement predicate type differs");
  invariant(Array.isArray(statement.subject) && statement.subject.length === 1, "Mirafold statement must have one subject");
  const [subject] = statement.subject;
  invariant(subject?.name === `pkg:npm/${SHELL_PACKAGE}@${evidence.version}`, "Mirafold statement subject differs");
  const expectedDigest = canonicalIntegrity(evidence.integrity, "observed Shell integrity")
    .slice("sha512-".length);
  invariant(subject?.digest?.sha512 === Buffer.from(expectedDigest, "base64").toString("hex"), "Mirafold statement digest differs");
}

function verifiedProvenanceSource(statement, evidence) {
  const build = statement?.predicate?.buildDefinition;
  invariant(build?.buildType === GITHUB_WORKFLOW_BUILD_TYPE, "Mirafold provenance build type differs");
  const workflow = build?.externalParameters?.workflow;
  const expectedRef = `refs/tags/v${evidence.version}`;
  invariant(workflow?.repository === SHELL_SOURCE_REPOSITORY, "Mirafold provenance source repository differs");
  invariant(workflow?.ref === expectedRef, "Mirafold provenance source ref differs");
  invariant(workflow?.path === SHELL_SOURCE_WORKFLOW, "Mirafold provenance workflow path differs");
  const expectedUri = `git+${SHELL_SOURCE_REPOSITORY}@${expectedRef}`;
  const sources = Array.isArray(build.resolvedDependencies)
    ? build.resolvedDependencies.filter((dependency) => dependency?.uri === expectedUri)
    : [];
  invariant(sources.length === 1, `Mirafold provenance contains ${sources.length} exact source records`);
  const commit = sources[0]?.digest?.gitCommit;
  invariant(typeof commit === "string" && GIT_COMMIT.test(commit), "Mirafold provenance source commit is invalid");
  invariant(
    statement?.predicate?.runDetails?.builder?.id === GITHUB_HOSTED_BUILDER,
    "Mirafold provenance builder is not GitHub-hosted",
  );
  return {
    repository: SHELL_SOURCE_REPOSITORY,
    ref: expectedRef,
    commit,
    workflow: SHELL_SOURCE_WORKFLOW,
    builder: GITHUB_HOSTED_BUILDER,
  };
}

export function verifyMirafoldProvenance(audit, evidence) {
  const entry = verifiedShellEntry(audit, evidence);
  const statement = verifiedProvenanceStatement(entry);
  validateProvenanceSubject(statement, evidence);
  return verifiedProvenanceSource(statement, evidence);
}

function manifestFrom(state, pair, source) {
  return {
    schemaVersion: INTAKE_SCHEMA_VERSION,
    package: SHELL_PACKAGE,
    registry: PUBLIC_NPM_REGISTRY,
    npmVersion: REQUIRED_NPM_VERSION,
    changed: state.preparation.changed,
    base: { ...state.base },
    desktopVersion: pair.desktopVersion,
    shell: {
      version: pair.shellVersion,
      tarball: pair.shellTarball,
      integrity: pair.shellIntegrity,
    },
    source,
    files: {
      "package.json": { sha256: pair.packageJsonSha256 },
      "package-lock.json": { sha256: pair.packageLockSha256 },
    },
  };
}

function removeDirectoryIfPresent(directory) {
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
}

export function verifyAndStageIntake({
  root = ROOT,
  stateFile,
  auditFile,
  outputDirectory,
  githubOutputFile,
} = {}) {
  invariant(typeof stateFile === "string" && stateFile.length > 0, "verify requires a state-file path");
  invariant(typeof auditFile === "string" && auditFile.length > 0, "verify requires an audit-file path");
  invariant(typeof outputDirectory === "string" && outputDirectory.length > 0, "verify requires an output directory");
  invariant(!existsSync(outputDirectory), "intake output directory already exists");
  const pair = readPair(root, "verified checkout");
  const state = readJson(stateFile, "intake state", STATE_LIMIT);
  const evidence = validateState(state, pair);
  invariant(state.preparation.changed, "a no-op intake must not create a downstream artifact");
  const audit = readJson(auditFile, "npm signature report", AUDIT_LIMIT);
  const source = verifyMirafoldProvenance(audit, evidence);
  const manifest = manifestFrom(state, pair, source);

  mkdirSync(outputDirectory, { mode: 0o700 });
  try {
    writeFileSync(path.join(outputDirectory, "package.json"), pair.packageText, { flag: "wx", mode: 0o600 });
    writeFileSync(path.join(outputDirectory, "package-lock.json"), pair.lockText, { flag: "wx", mode: 0o600 });
    writeFileSync(path.join(outputDirectory, "shell-intake.json"), jsonText(manifest), { flag: "wx", mode: 0o600 });
  } catch (error) {
    removeDirectoryIfPresent(outputDirectory);
    throw error;
  }
  appendGithubOutputs(githubOutputFile, {
    "source-commit": source.commit,
    "package-json-sha256": pair.packageJsonSha256,
    "package-lock-sha256": pair.packageLockSha256,
  });
  return manifest;
}

function validateManifest(value, pair) {
  exactKeys(
    value,
    ["schemaVersion", "package", "registry", "npmVersion", "changed", "base", "desktopVersion", "shell", "source", "files"],
    "intake manifest",
  );
  validateIntakeIdentity(value, "intake manifest");
  invariant(value.changed === true, "downstream intake manifest must describe a change");
  stableVersion(value.desktopVersion, "intake manifest Desktop version");
  validateBaseRecord(value.base, "intake manifest base");

  exactKeys(value.shell, ["version", "tarball", "integrity"], "intake manifest Shell");
  const shell = normalizeEvidence(value.shell, "intake manifest Shell");
  exactKeys(value.source, ["repository", "ref", "commit", "workflow", "builder"], "intake manifest source");
  invariant(value.source.repository === SHELL_SOURCE_REPOSITORY, "intake manifest source repository differs");
  invariant(value.source.ref === `refs/tags/v${shell.version}`, "intake manifest source ref differs");
  invariant(GIT_COMMIT.test(value.source.commit), "intake manifest source commit is invalid");
  invariant(value.source.workflow === SHELL_SOURCE_WORKFLOW, "intake manifest source workflow differs");
  invariant(value.source.builder === GITHUB_HOSTED_BUILDER, "intake manifest source builder differs");
  invariant(value.desktopVersion === nextPatchVersion(value.base.desktopVersion), "intake artifact Desktop version is not one patch above its base");
  invariant(compareStableVersions(shell.version, value.base.shellVersion) > 0, "intake artifact Shell version did not advance");

  exactKeys(value.files, ["package.json", "package-lock.json"], "intake manifest files");
  exactKeys(value.files["package.json"], ["sha256"], "intake manifest package file");
  exactKeys(value.files["package-lock.json"], ["sha256"], "intake manifest lock file");
  invariant(SHA256_HEX.test(value.files["package.json"].sha256), "intake manifest package hash is invalid");
  invariant(SHA256_HEX.test(value.files["package-lock.json"].sha256), "intake manifest lock hash is invalid");
  invariant(value.desktopVersion === pair.desktopVersion, "intake artifact Desktop version differs");
  invariant(shell.version === pair.shellVersion, "intake artifact Shell version differs");
  invariant(shell.integrity === pair.shellIntegrity, "intake artifact Shell integrity differs");
  invariant(shell.tarball === pair.shellTarball, "intake artifact Shell tarball differs");
  invariant(value.files["package.json"].sha256 === pair.packageJsonSha256, "intake artifact package hash differs");
  invariant(value.files["package-lock.json"].sha256 === pair.packageLockSha256, "intake artifact lock hash differs");
  return value;
}

export function readIntakeArtifact(directory) {
  invariant(typeof directory === "string" && directory.length > 0, "artifact directory is required");
  invariant(lstatSync(directory).isDirectory(), "intake artifact path must be a directory");
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  invariant(
    names.length === ARTIFACT_FILES.length && names.every((name, index) => name === ARTIFACT_FILES[index]),
    `intake artifact files differ; expected [${ARTIFACT_FILES.join(", ")}], found [${names.join(", ")}]`,
  );
  invariant(entries.every((entry) => entry.isFile()), "every intake artifact entry must be a regular file");
  const packageText = readRegularText(path.join(directory, "package.json"), "intake package.json", PACKAGE_LIMIT);
  const lockText = readRegularText(path.join(directory, "package-lock.json"), "intake package-lock.json", LOCK_LIMIT);
  const pair = validatePairTexts(packageText, lockText, "intake artifact");
  const manifest = readJson(path.join(directory, "shell-intake.json"), "intake manifest", STATE_LIMIT);
  validateManifest(manifest, pair);
  return { pair, manifest };
}

export function applyIntakeArtifact({ root = ROOT, artifactDirectory } = {}) {
  const { pair, manifest } = readIntakeArtifact(artifactDirectory);
  const current = readPair(root, "consumer checkout");
  invariant(current.packageName === pair.packageName, "intake artifact belongs to a different package");
  invariant(current.desktopVersion === manifest.base.desktopVersion, "consumer Desktop version differs from intake base");
  invariant(current.shellVersion === manifest.base.shellVersion, "consumer Shell version differs from intake base");
  invariant(current.packageJsonSha256 === manifest.base.packageJsonSha256, "consumer package.json differs from intake base");
  invariant(current.packageLockSha256 === manifest.base.packageLockSha256, "consumer package-lock.json differs from intake base");
  commitPreparedFiles({
    root,
    packageText: pair.packageText,
    lockText: pair.lockText,
    originalPackageText: current.packageText,
    originalLockText: current.lockText,
  });
  return manifest;
}

export function checkAppliedIntake({ root = ROOT, artifactDirectory } = {}) {
  const { pair, manifest } = readIntakeArtifact(artifactDirectory);
  const current = readPair(root, "applied checkout");
  invariant(current.packageJsonSha256 === pair.packageJsonSha256, "applied package.json changed after intake");
  invariant(current.packageLockSha256 === pair.packageLockSha256, "applied package-lock.json changed after intake");
  return manifest;
}

function usage() {
  return [
    "usage:",
    "  shell-intake.mjs prepare STATE_FILE [GITHUB_OUTPUT_FILE]",
    "  shell-intake.mjs verify STATE_FILE AUDIT_JSON OUTPUT_DIRECTORY [GITHUB_OUTPUT_FILE]",
    "  shell-intake.mjs apply ARTIFACT_DIRECTORY [ROOT]",
    "  shell-intake.mjs check ARTIFACT_DIRECTORY [ROOT]",
  ].join("\n");
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "prepare" && (rest.length === 1 || rest.length === 2)) {
    const result = await prepareIntake({ stateFile: rest[0], githubOutputFile: rest[1] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "verify" && (rest.length === 3 || rest.length === 4)) {
    const result = verifyAndStageIntake({
      stateFile: rest[0],
      auditFile: rest[1],
      outputDirectory: rest[2],
      githubOutputFile: rest[3],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if ((command === "apply" || command === "check") && (rest.length === 1 || rest.length === 2)) {
    const operation = command === "apply" ? applyIntakeArtifact : checkAppliedIntake;
    const result = operation({ artifactDirectory: rest[0], root: rest[1] ?? ROOT });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Shell intake failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
