#!/usr/bin/env node

// Prepare exactly one Desktop release for an already-observed Mirafold Shell
// version. This command is deliberately narrower than a generic dependency
// updater: it accepts only npm's current stable `latest`, pins that exact Shell
// version, advances Desktop by one patch, and refuses lockfile churn outside
// Mirafold's old/new dependency closure.
//
// All npm work happens in a disposable directory with lifecycle scripts
// disabled. The real package files are written only after registry evidence,
// the generated lock, and a second registry check all agree.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonicalIntegrity, invariant, jsonText, STABLE_VERSION } from "./shared.mjs";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
export const REQUIRED_NPM_VERSION = "12.0.2";
const LATEST_URL = `${PUBLIC_NPM_REGISTRY}/mirafold/latest`;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function parseJson(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must contain an object`);
  return value;
}

function stableVersionParts(value, label) {
  invariant(typeof value === "string" && STABLE_VERSION.test(value), `${label} must be a stable x.y.z version`);
  return value.split(".").map((part) => BigInt(part));
}

export function compareStableVersions(left, right) {
  const a = stableVersionParts(left, "left version");
  const b = stableVersionParts(right, "right version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

export function nextPatchVersion(version) {
  const [major, minor, patch] = stableVersionParts(version, "Desktop version");
  return `${major}.${minor}.${patch + 1n}`;
}

function expectedTarball(version) {
  return `${PUBLIC_NPM_REGISTRY}/mirafold/-/mirafold-${version}.tgz`;
}

function validateRegistryEvidence(evidence, observedVersion) {
  stableVersionParts(observedVersion, "observed Shell version");
  invariant(evidence && typeof evidence === "object", "npm latest evidence is missing");
  invariant(
    evidence.version === observedVersion,
    `observed Shell ${observedVersion} is not npm latest ${String(evidence.version)}`,
  );
  canonicalIntegrity(evidence.integrity, "npm latest integrity");
  invariant(
    evidence.tarball === expectedTarball(observedVersion),
    `npm latest tarball is not the fixed public-registry URL for ${observedVersion}`,
  );
  return {
    version: evidence.version,
    integrity: evidence.integrity,
    tarball: evidence.tarball,
  };
}

export async function fetchLatestShellEvidence() {
  const response = await fetch(LATEST_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  invariant(response.ok, `npm latest request failed with HTTP ${response.status}`);
  const metadata = await response.json();
  return {
    version: metadata?.version,
    integrity: metadata?.dist?.integrity,
    tarball: metadata?.dist?.tarball,
  };
}

function exactShellVersion(manifest, label) {
  const value = manifest?.dependencies?.mirafold;
  stableVersionParts(value, `${label} Mirafold dependency`);
  return value;
}

function validateRepositoryState(packageMetadata, lockMetadata) {
  invariant(typeof packageMetadata.name === "string" && packageMetadata.name, "package.json has no package name");
  stableVersionParts(packageMetadata.version, "package.json Desktop version");
  invariant(lockMetadata.lockfileVersion === 3, "package-lock.json must use lockfileVersion 3");
  invariant(lockMetadata.name === packageMetadata.name, "package and lock names differ");
  invariant(lockMetadata.version === packageMetadata.version, "package and lock Desktop versions differ");
  invariant(lockMetadata.packages && typeof lockMetadata.packages === "object", "package-lock.json has no packages map");
  const root = lockMetadata.packages[""];
  invariant(root && typeof root === "object", "package-lock.json has no root package record");
  invariant(root.name === packageMetadata.name, "lock root package name differs from package.json");
  invariant(root.version === packageMetadata.version, "lock root Desktop version differs from package.json");

  const shellVersion = exactShellVersion(packageMetadata, "package.json");
  invariant(
    exactShellVersion(root, "lock root") === shellVersion,
    "package and lock root Mirafold versions differ",
  );
  const shell = lockMetadata.packages["node_modules/mirafold"];
  invariant(shell && typeof shell === "object", "package-lock.json has no installed Mirafold record");
  invariant(shell.version === shellVersion, "lock root pin and installed Mirafold record differ");
  invariant(shell.resolved === expectedTarball(shellVersion), "Mirafold lock entry is not resolved from the public registry");
  canonicalIntegrity(shell.integrity, "Mirafold lock integrity");
  return { desktopVersion: packageMetadata.version, shellVersion, shell };
}

function resolveDependency(packages, fromKey, dependency) {
  let current = fromKey;
  while (current) {
    const nested = `${current}/node_modules/${dependency}`;
    if (packages[nested]) return nested;
    const marker = current.lastIndexOf("/node_modules/");
    if (marker === -1) break;
    current = current.slice(0, marker);
  }
  const root = `node_modules/${dependency}`;
  return packages[root] ? root : null;
}

function dependencyClosure(lockMetadata, startKey) {
  const packages = lockMetadata.packages;
  const closure = new Set();
  const queue = [startKey];
  while (queue.length > 0) {
    const key = queue.shift();
    if (closure.has(key) || !packages[key]) continue;
    closure.add(key);
    const record = packages[key];
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = record[field];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const dependency of Object.keys(dependencies)) {
        const resolved = resolveDependency(packages, key, dependency);
        if (resolved && !closure.has(resolved)) queue.push(resolved);
      }
    }
  }
  return closure;
}

function validateLockChurn(before, after) {
  const topKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of topKeys) {
    if (key === "version" || key === "packages") continue;
    invariant(isDeepStrictEqual(before[key], after[key]), `package-lock top-level ${key} changed unexpectedly`);
  }

  const allowed = new Set([
    ...dependencyClosure(before, "node_modules/mirafold"),
    ...dependencyClosure(after, "node_modules/mirafold"),
  ]);
  const packageKeys = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
  for (const key of packageKeys) {
    if (key === "") continue;
    if (isDeepStrictEqual(before.packages[key], after.packages[key])) continue;
    invariant(allowed.has(key), `npm changed unrelated lock entry ${key || "<root>"}`);
  }
}

function minimalChildEnvironment(extra = {}) {
  const env = { ...extra };
  for (const name of [
    "PATH",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function npmInvocation(args) {
  // `npm run` provides the exact npm CLI file it used. Invoke that JavaScript
  // through this Node binary instead of spawning npm.cmd: Node cannot execute
  // Windows command files safely without a shell, and shell quoting would make
  // temporary paths part of a command-injection surface.
  const npmCli = process.env.npm_execpath;
  if (
    typeof npmCli === "string" &&
    path.isAbsolute(npmCli) &&
    path.basename(npmCli).toLowerCase() === "npm-cli.js"
  ) {
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  invariant(process.platform !== "win32", "on Windows, run preparation through npm run release:prepare");
  return { command: "npm", args };
}

function sanitizeProcessOutput(value) {
  return String(value ?? "")
    .replace(/([?&](?:access_token|auth|key|token)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(\/\/[A-Za-z0-9.-]+\/:_authToken=)[^\s]+/gi, "$1<redacted>")
    .slice(-4000);
}

function runNpm(args, options = {}) {
  const invocation = npmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? minimalChildEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw new Error(`could not run npm: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`npm ${args[0]} failed (${result.status}): ${sanitizeProcessOutput(result.stderr)}`);
  }
  return result.stdout.trim();
}

function installedNpmVersion() {
  return runNpm(["--version"]);
}

export function lockRefreshArguments(shellVersion) {
  stableVersionParts(shellVersion, "Shell version");
  return [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--save-exact",
    "--audit=false",
    "--fund=false",
    "--prefer-online",
    `--registry=${PUBLIC_NPM_REGISTRY}`,
    `mirafold@${shellVersion}`,
  ];
}

async function refreshLockWithNpm({ directory, shellVersion }) {
  const userConfig = path.join(directory, "empty-npmrc");
  const cache = path.join(directory, "npm-cache");
  writeFileSync(userConfig, "");
  runNpm(lockRefreshArguments(shellVersion), {
    cwd: directory,
    env: minimalChildEnvironment({
      CI: "true",
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY,
    }),
  });
  invariant(!existsSync(path.join(directory, "node_modules")), "lock refresh unexpectedly created node_modules");
}

function writeReplacement(target, text, suffix) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
  const mode = statSync(target).mode & 0o777;
  writeFileSync(temporary, text, { mode });
  chmodSync(temporary, mode);
  return temporary;
}

function unlinkIfPresent(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function commitPreparedFiles({ root, packageText, lockText, originalPackageText, originalLockText }) {
  const packageFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  invariant(readFileSync(packageFile, "utf8") === originalPackageText, "package.json changed during preparation");
  invariant(readFileSync(lockFile, "utf8") === originalLockText, "package-lock.json changed during preparation");
  invariant(lstatSync(packageFile).isFile(), "package.json must be a regular file");
  invariant(lstatSync(lockFile).isFile(), "package-lock.json must be a regular file");

  const suffix = `mirafold-release-${process.pid}-${randomUUID()}`;
  let packageTemporary = null;
  let lockTemporary = null;
  let packageReplaced = false;
  try {
    packageTemporary = writeReplacement(packageFile, packageText, suffix);
    lockTemporary = writeReplacement(lockFile, lockText, suffix);
    renameSync(packageTemporary, packageFile);
    packageTemporary = null;
    packageReplaced = true;
    renameSync(lockTemporary, lockFile);
    lockTemporary = null;
  } catch (error) {
    if (packageReplaced) {
      const rollback = writeReplacement(packageFile, originalPackageText, `${suffix}-rollback`);
      renameSync(rollback, packageFile);
    }
    throw error;
  } finally {
    if (packageTemporary) unlinkIfPresent(packageTemporary);
    if (lockTemporary) unlinkIfPresent(lockTemporary);
  }
}

function validatePreparedState({
  beforePackage,
  beforeLock,
  afterPackage,
  afterLock,
  nextDesktopVersion,
  shellVersion,
  evidence,
}) {
  const expectedPackage = structuredClone(beforePackage);
  expectedPackage.version = nextDesktopVersion;
  expectedPackage.dependencies.mirafold = shellVersion;
  invariant(isDeepStrictEqual(afterPackage, expectedPackage), "npm changed package.json outside the two release fields");

  const expectedRoot = structuredClone(beforeLock.packages[""]);
  expectedRoot.version = nextDesktopVersion;
  expectedRoot.dependencies.mirafold = shellVersion;
  invariant(afterLock.version === nextDesktopVersion, "npm did not update the lockfile Desktop version");
  invariant(
    isDeepStrictEqual(afterLock.packages[""], expectedRoot),
    "npm changed the lock root outside the two release fields",
  );
  const state = validateRepositoryState(afterPackage, afterLock);
  invariant(state.shell.integrity === evidence.integrity, "prepared lock integrity differs from npm latest evidence");
  invariant(state.shell.resolved === evidence.tarball, "prepared lock tarball differs from npm latest evidence");
  validateLockChurn(beforeLock, afterLock);
}

export async function prepareShellRelease({
  root = ROOT,
  observedVersion,
  queryLatest = fetchLatestShellEvidence,
  refreshLock = refreshLockWithNpm,
  npmVersion = installedNpmVersion(),
  commitFiles = commitPreparedFiles,
} = {}) {
  stableVersionParts(observedVersion, "observed Shell version");
  invariant(
    npmVersion === REQUIRED_NPM_VERSION,
    `release preparation requires npm ${REQUIRED_NPM_VERSION}, found ${npmVersion}`,
  );

  const packageFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  const originalPackageText = readFileSync(packageFile, "utf8");
  const originalLockText = readFileSync(lockFile, "utf8");
  const packageMetadata = parseJson(originalPackageText, "package.json");
  const lockMetadata = parseJson(originalLockText, "package-lock.json");
  const current = validateRepositoryState(packageMetadata, lockMetadata);
  const firstEvidence = validateRegistryEvidence(await queryLatest(), observedVersion);
  const order = compareStableVersions(observedVersion, current.shellVersion);
  invariant(order >= 0, `observed Shell ${observedVersion} is older than pinned ${current.shellVersion}`);

  if (order === 0) {
    invariant(
      current.shell.integrity === firstEvidence.integrity,
      "current Mirafold lock integrity differs from npm latest evidence",
    );
    invariant(
      current.shell.resolved === firstEvidence.tarball,
      "current Mirafold lock tarball differs from npm latest evidence",
    );
    return {
      changed: false,
      desktopVersion: current.desktopVersion,
      shellVersion: current.shellVersion,
      integrity: current.shell.integrity,
    };
  }

  const nextDesktopVersion = nextPatchVersion(current.desktopVersion);
  const staging = mkdtempSync(path.join(tmpdir(), "mirafold-release-preparation-"));
  try {
    const stagedPackage = structuredClone(packageMetadata);
    stagedPackage.version = nextDesktopVersion;
    stagedPackage.dependencies.mirafold = observedVersion;
    writeFileSync(path.join(staging, "package.json"), jsonText(stagedPackage));
    writeFileSync(path.join(staging, "package-lock.json"), originalLockText);
    await refreshLock({ directory: staging, shellVersion: observedVersion });

    const afterPackageText = readFileSync(path.join(staging, "package.json"), "utf8");
    const afterLockText = readFileSync(path.join(staging, "package-lock.json"), "utf8");
    const afterPackage = parseJson(afterPackageText, "prepared package.json");
    const afterLock = parseJson(afterLockText, "prepared package-lock.json");
    const secondEvidence = validateRegistryEvidence(await queryLatest(), observedVersion);
    invariant(
      isDeepStrictEqual(secondEvidence, firstEvidence),
      "npm latest evidence changed while the release was being prepared",
    );
    validatePreparedState({
      beforePackage: packageMetadata,
      beforeLock: lockMetadata,
      afterPackage,
      afterLock,
      nextDesktopVersion,
      shellVersion: observedVersion,
      evidence: secondEvidence,
    });

    commitFiles({
      root,
      packageText: afterPackageText,
      lockText: afterLockText,
      originalPackageText,
      originalLockText,
    });
    return {
      changed: true,
      previousDesktopVersion: current.desktopVersion,
      desktopVersion: nextDesktopVersion,
      previousShellVersion: current.shellVersion,
      shellVersion: observedVersion,
      integrity: secondEvidence.integrity,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args.length !== 1) {
    throw new Error("usage: prepare-shell-release.mjs OBSERVED_NPM_LATEST_VERSION");
  }
  const result = await prepareShellRelease({ observedVersion: args[0] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release preparation failed: ${sanitizeProcessOutput(error.message)}\n`);
    process.exitCode = 1;
  });
}
