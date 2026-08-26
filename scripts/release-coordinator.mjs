#!/usr/bin/env node

// Release-writer policy for scheduled Mirafold Shell updates.
//
// This module deliberately uses only Node's standard library plus the two
// repository-owned policy modules below. It is the only project code loaded by
// the write-capable workflow job: npm packages are neither installed nor run
// beside the credential that can advance main, create a tag, and publish.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyIntakeArtifact,
  checkAppliedIntake,
} from "./shell-intake.mjs";
import {
  assertReleaseIdentity,
  expectedReleaseAssets,
  verifyCompleteArtifacts,
} from "./release-contract.mjs";
import { appendGithubOutputs, exactKeys, invariant, jsonText, sha256, stableVersion } from "./shared.mjs";

export const RELEASE_PLAN_SCHEMA_VERSION = 2;
export const RELEASE_REPOSITORY = "mirafold/mirafold-desktop";
export const RELEASE_BRANCH = "main";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GIT_OBJECT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PLAN_LIMIT = 1024 * 1024;

function gitObject(value, label) {
  invariant(typeof value === "string" && GIT_OBJECT.test(value), `${label} must be a 40-hex Git object`);
  return value;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function canonicalReleaseNotes(value) {
  invariant(typeof value === "string" || Buffer.isBuffer(value), "release notes must be text");
  return Buffer.from(value).toString("utf8").replaceAll("\r\n", "\n").trimEnd() + "\n";
}

function writeExclusive(file, value, label) {
  invariant(!existsSync(file), `${label} already exists`);
  writeFileSync(file, value, { flag: "wx", mode: 0o600 });
}

// Keep this small adapter local instead of expanding Shell intake's exported
// interface solely to share it across two independently reviewed boundaries.
function runGit(root, args, { allowExit = [] } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  if (result.signal !== null) throw new Error(`git ${args[0]} ended from signal ${result.signal}`);
  if (result.status !== 0 && !allowExit.includes(result.status)) {
    const detail = String(result.stderr || result.stdout).trim().slice(-4000);
    throw new Error(`git ${args[0]} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function gitLine(root, args) {
  return runGit(root, args).stdout.trim();
}

function listLines(value) {
  return String(value).split(/\r?\n/).filter(Boolean).sort();
}

function checkoutStatus(root) {
  return runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout
    .split("\0")
    .filter(Boolean);
}

function assertCleanCheckout(root, label) {
  const status = checkoutStatus(root);
  invariant(status.length === 0, `${label} is not clean: ${status.join(", ")}`);
}

function assertOnlyPreparedFiles(root) {
  const expected = ["package-lock.json", "package.json"];
  const status = checkoutStatus(root);
  const actual = status.map((entry) => entry.slice(3)).sort();
  invariant(
    status.length === 2
      && status.every((entry) => entry.startsWith(" M "))
      && actual.every((name, index) => name === expected[index]),
    `prepared checkout changes differ; expected [${expected.join(", ")}], found [${status.join(", ")}]`,
  );
  const unstaged = listLines(runGit(root, ["diff", "--name-only", "--"]).stdout);
  invariant(JSON.stringify(unstaged) === JSON.stringify(expected), "prepared unstaged files differ");
  invariant(runGit(root, ["diff", "--check"]).stdout === "", "prepared source fails git diff --check");
}

// The identity the writer commits and signs off as. Every commit on `main`
// carries a Developer Certificate of Origin sign-off (docs/RELEASING.md); the
// automated release commit is no exception, so the DCO check stays green on
// main and the trailer below is part of the reviewed commit message.
export const AUTOMATED_AUTHOR = Object.freeze({
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
});

/** The single-line subject the workflow hands to `git commit -s -m`. */
export function automatedCommitSubject(desktopVersion, shellVersion) {
  stableVersion(desktopVersion, "Desktop version");
  stableVersion(shellVersion, "Shell version");
  return `release: Desktop ${desktopVersion} with Shell ${shellVersion}`;
}

/** The complete commit message `git commit -s -m <subject>` produces. */
export function automatedCommitMessage(desktopVersion, shellVersion) {
  return `${automatedCommitSubject(desktopVersion, shellVersion)}\n\nSigned-off-by: ${AUTOMATED_AUTHOR.name} <${AUTOMATED_AUTHOR.email}>`;
}

export function automatedReleaseNotes(manifest) {
  const desktopVersion = stableVersion(manifest?.desktopVersion, "Desktop version");
  const shellVersion = stableVersion(manifest?.shell?.version, "Shell version");
  const sourceCommit = gitObject(manifest?.source?.commit, "Shell source commit");
  invariant(manifest?.source?.repository === "https://github.com/mirafold/mirafold", "Shell source repository differs");
  invariant(manifest?.source?.ref === `refs/tags/v${shellVersion}`, "Shell source ref differs");
  return [
    "## Included versions",
    "",
    `- Mirafold Desktop \`${desktopVersion}\``,
    `- Mirafold Shell \`${shellVersion}\``,
    "",
    "This release was prepared automatically from the exact npm package whose registry signature and SLSA provenance passed the Desktop intake policy.",
    "",
    `- Shell release: https://github.com/mirafold/mirafold/releases/tag/v${shellVersion}`,
    `- Shell source commit: \`${sourceCommit}\``,
    "",
  ].join("\n");
}

async function expectedAssetRecords(directory, version) {
  return Promise.all(expectedReleaseAssets(version).map(async (name) => {
    const file = path.join(directory, name);
    return {
      name,
      size: statSync(file).size,
      sha256: await sha256File(file),
    };
  }));
}

export async function prepareReleaseCandidate({
  root = ROOT,
  artifactDirectory,
  assetsDirectory,
  baseCommit,
  planFile,
  notesFile,
  githubOutputFile,
} = {}) {
  gitObject(baseCommit, "intake base commit");
  invariant(typeof artifactDirectory === "string" && artifactDirectory.length > 0, "intake artifact directory is required");
  invariant(typeof assetsDirectory === "string" && assetsDirectory.length > 0, "release assets directory is required");
  invariant(typeof planFile === "string" && planFile.length > 0, "release plan path is required");
  invariant(typeof notesFile === "string" && notesFile.length > 0, "release notes path is required");
  assertCleanCheckout(root, "release-writer checkout before intake");
  invariant(gitLine(root, ["rev-parse", "HEAD^{commit}"]) === baseCommit, "writer checkout does not equal intake github.sha");

  const applied = applyIntakeArtifact({ root, artifactDirectory: path.resolve(artifactDirectory) });
  invariant(applied.changed === true, "release writer requires a changed intake artifact");
  await verifyCompleteArtifacts(path.resolve(assetsDirectory), applied.desktopVersion);
  const manifest = checkAppliedIntake({ root, artifactDirectory: path.resolve(artifactDirectory) });
  assertOnlyPreparedFiles(root);

  runGit(root, ["add", "--", "package.json", "package-lock.json"]);
  const staged = listLines(runGit(root, ["diff", "--cached", "--name-only", "--"]).stdout);
  invariant(JSON.stringify(staged) === JSON.stringify(["package-lock.json", "package.json"]), "staged release files differ");
  invariant(runGit(root, ["diff", "--name-only", "--"]).stdout === "", "release writer has unstaged changes");
  const candidateTree = gitObject(gitLine(root, ["write-tree"]), "candidate tree");

  const notes = automatedReleaseNotes(manifest);
  const tag = `v${manifest.desktopVersion}`;
  assertReleaseIdentity(tag, manifest.desktopVersion);
  const plan = {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    repository: RELEASE_REPOSITORY,
    branch: RELEASE_BRANCH,
    baseCommit,
    candidateTree,
    desktopVersion: manifest.desktopVersion,
    shell: {
      version: manifest.shell.version,
      sourceCommit: manifest.source.commit,
      sourceRef: manifest.source.ref,
    },
    tag,
    commitMessage: automatedCommitMessage(manifest.desktopVersion, manifest.shell.version),
    tagMessage: `Mirafold Desktop ${tag}`,
    releaseTitle: `Mirafold Desktop ${tag}`,
    files: {
      "package.json": manifest.files["package.json"].sha256,
      "package-lock.json": manifest.files["package-lock.json"].sha256,
    },
    assets: await expectedAssetRecords(path.resolve(assetsDirectory), manifest.desktopVersion),
    notesSha256: sha256(canonicalReleaseNotes(notes)),
  };
  validateReleasePlan(plan);
  writeExclusive(notesFile, notes, "release notes file");
  writeExclusive(planFile, jsonText(plan), "release plan file");
  appendGithubOutputs(githubOutputFile, {
    tag: plan.tag,
    "desktop-version": plan.desktopVersion,
    "shell-version": plan.shell.version,
    "commit-subject": automatedCommitSubject(plan.desktopVersion, plan.shell.version),
    "tag-message": plan.tagMessage,
    "release-title": plan.releaseTitle,
  });
  return plan;
}

export function validateReleasePlan(value) {
  exactKeys(value, [
    "schemaVersion",
    "repository",
    "branch",
    "baseCommit",
    "candidateTree",
    "desktopVersion",
    "shell",
    "tag",
    "commitMessage",
    "tagMessage",
    "releaseTitle",
    "files",
    "assets",
    "notesSha256",
  ], "release plan");
  invariant(value.schemaVersion === RELEASE_PLAN_SCHEMA_VERSION, "release plan schema is unsupported");
  invariant(value.repository === RELEASE_REPOSITORY, "release plan repository differs");
  invariant(value.branch === RELEASE_BRANCH, "release plan branch differs");
  gitObject(value.baseCommit, "release plan base commit");
  gitObject(value.candidateTree, "release plan candidate tree");
  stableVersion(value.desktopVersion, "release plan Desktop version");
  assertReleaseIdentity(value.tag, value.desktopVersion);

  exactKeys(value.shell, ["version", "sourceCommit", "sourceRef"], "release plan Shell");
  stableVersion(value.shell.version, "release plan Shell version");
  gitObject(value.shell.sourceCommit, "release plan Shell source commit");
  invariant(value.shell.sourceRef === `refs/tags/v${value.shell.version}`, "release plan Shell source ref differs");
  invariant(value.commitMessage === automatedCommitMessage(value.desktopVersion, value.shell.version), "release plan commit message differs");
  invariant(value.tagMessage === `Mirafold Desktop ${value.tag}`, "release plan tag message differs");
  invariant(value.releaseTitle === `Mirafold Desktop ${value.tag}`, "release plan title differs");

  exactKeys(value.files, ["package.json", "package-lock.json"], "release plan files");
  invariant(SHA256.test(value.files["package.json"]), "release plan package hash is invalid");
  invariant(SHA256.test(value.files["package-lock.json"]), "release plan lock hash is invalid");
  invariant(SHA256.test(value.notesSha256), "release plan notes hash is invalid");
  invariant(Array.isArray(value.assets), "release plan assets must be an array");
  const expected = expectedReleaseAssets(value.desktopVersion);
  const names = value.assets.map((asset) => asset?.name).sort();
  invariant(JSON.stringify(names) === JSON.stringify(expected), "release plan asset names differ");
  for (const asset of value.assets) {
    exactKeys(asset, ["name", "size", "sha256"], `release plan asset ${asset?.name}`);
    invariant(Number.isSafeInteger(asset.size) && asset.size > 0, `release plan asset ${asset.name} has invalid size`);
    invariant(SHA256.test(asset.sha256), `release plan asset ${asset.name} has invalid SHA-256`);
  }
  return value;
}

export function readReleasePlan(file) {
  const record = lstatSync(file);
  invariant(record.isFile(), "release plan must be a regular file");
  invariant(record.size <= PLAN_LIMIT, "release plan is too large");
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`release plan is not valid JSON: ${error.message}`);
  }
  return validateReleasePlan(value);
}

export function verifyReleaseNotes(planValue, file) {
  const plan = validateReleasePlan(planValue);
  const record = lstatSync(file);
  invariant(record.isFile(), "release notes must be a regular file");
  invariant(record.size <= PLAN_LIMIT, "release notes are too large");
  invariant(
    sha256(canonicalReleaseNotes(readFileSync(file))) === plan.notesSha256,
    "release notes differ from the reviewed plan",
  );
  return plan.notesSha256;
}

function exactRemoteAssets(release, plan) {
  if (!Array.isArray(release?.assets)) return false;
  const expected = [...plan.assets].sort((left, right) => left.name.localeCompare(right.name));
  const actual = release.assets
    .map((asset) => ({ name: asset?.name, size: asset?.size, digest: asset?.digest }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return actual.length === expected.length
    && actual.every((asset, index) =>
      asset.name === expected[index].name
      && asset.size === expected[index].size
      && asset.digest === `sha256:${expected[index].sha256}`
    );
}

function exactRemoteMetadata(release, plan) {
  return release?.title === plan.releaseTitle
    && typeof release?.body === "string"
    && sha256(canonicalReleaseNotes(release.body)) === plan.notesSha256;
}

function assertCandidateCommit(plan, main) {
  invariant(main.commit === main.sha, "remote main commit identity differs");
  invariant(main.parent === plan.baseCommit, "remote release commit parent differs from intake base");
  invariant(main.tree === plan.candidateTree, "remote release commit tree differs from reviewed candidate");
  invariant(main.message === plan.commitMessage, "remote release commit message differs from reviewed candidate");
}

export function classifyRemoteRelease(planValue, state) {
  const plan = validateReleasePlan(planValue);
  invariant(state && typeof state === "object" && !Array.isArray(state), "remote state is missing");
  invariant(state.main && typeof state.main === "object", "remote main state is missing");
  gitObject(state.main.sha, "remote main commit");

  if (state.tag === null || state.tag === undefined) {
    invariant(state.release === null || state.release === undefined, "remote release exists without its reviewed tag");
    invariant(state.main.sha === plan.baseCommit, "remote main moved from the intake base before publication");
    return { mode: "create", releaseCommit: null };
  }

  invariant(state.main.sha !== plan.baseCommit, `tag ${plan.tag} collides while main still equals the intake base`);
  assertCandidateCommit(plan, state.main);
  invariant(state.tag.annotated === true, `tag ${plan.tag} is not annotated`);
  invariant(state.tag.commit === state.main.sha, `tag ${plan.tag} does not point to the reviewed release commit`);

  if (state.release === null || state.release === undefined) {
    return { mode: "release-create", releaseCommit: state.main.sha };
  }
  invariant(state.release.tagName === plan.tag, "remote release tag differs from the release plan");

  if (state.release.isDraft === true) {
    const complete = state.release.isPrerelease === false
      && exactRemoteMetadata(state.release, plan)
      && exactRemoteAssets(state.release, plan);
    return { mode: complete ? "draft-complete" : "draft-replace", releaseCommit: state.main.sha };
  }

  invariant(state.release.isDraft === false, "remote release draft state is invalid");
  invariant(state.release.isPrerelease === false, "published stable release is marked prerelease");
  invariant(exactRemoteMetadata(state.release, plan), "published release title or notes differ from the reviewed plan");
  invariant(exactRemoteAssets(state.release, plan), "published release assets differ from the reviewed complete set");
  invariant(state.latest?.tagName === plan.tag, "published release is not GitHub's latest release");
  invariant(state.latest?.isDraft === false && state.latest?.isPrerelease === false, "GitHub latest release state differs");
  return { mode: "complete", releaseCommit: state.main.sha };
}

async function githubRequest(fetchImpl, token, endpoint, label, { missing = false } = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPOSITORY}${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "mirafold-desktop-release-writer",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (missing && response.status === 404) return null;
  invariant(response.ok, `GitHub API ${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub API ${label} did not return JSON`);
  }
}

function normalizeRelease(value) {
  if (value === null) return null;
  return {
    tagName: value.tag_name,
    title: value.name,
    body: value.body,
    isDraft: value.draft,
    isPrerelease: value.prerelease,
    assets: Array.isArray(value.assets)
      ? value.assets.map((asset) => ({ name: asset.name, size: asset.size, digest: asset.digest }))
      : null,
  };
}

export async function inspectRemoteRelease(planValue, {
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  const plan = validateReleasePlan(planValue);
  invariant(typeof token === "string" && token.length > 0, "GH_TOKEN is required for remote release inspection");
  invariant(typeof fetchImpl === "function", "a fetch implementation is required");

  const mainRef = await githubRequest(fetchImpl, token, `/git/ref/heads/${RELEASE_BRANCH}`, "main ref");
  const mainSha = gitObject(mainRef?.object?.sha, "GitHub main ref");
  invariant(mainRef?.object?.type === "commit", "GitHub main ref does not point to a commit");
  const mainCommit = await githubRequest(fetchImpl, token, `/git/commits/${mainSha}`, "main commit");
  invariant(Array.isArray(mainCommit?.parents) && mainCommit.parents.length >= 1, "GitHub main commit has no parent");
  const main = {
    sha: mainSha,
    commit: gitObject(mainCommit.sha, "GitHub main commit response"),
    parent: mainCommit.parents.length === 1 ? gitObject(mainCommit.parents[0]?.sha, "GitHub main parent") : null,
    tree: gitObject(mainCommit?.tree?.sha, "GitHub main tree"),
    message: mainCommit.message,
  };

  const tagRef = await githubRequest(fetchImpl, token, `/git/ref/tags/${encodeURIComponent(plan.tag)}`, "release tag", { missing: true });
  let tag = null;
  if (tagRef !== null) {
    let object = tagRef.object;
    let annotated = false;
    for (let depth = 0; object?.type === "tag"; depth += 1) {
      invariant(depth < 4, "release tag nesting is too deep");
      annotated = true;
      const tagObject = await githubRequest(fetchImpl, token, `/git/tags/${gitObject(object.sha, "GitHub tag object")}`, "annotated tag");
      object = tagObject.object;
    }
    invariant(object?.type === "commit", "release tag does not resolve to a commit");
    tag = { annotated, commit: gitObject(object.sha, "release tag commit") };
  }

  const [releaseResponse, latestResponse] = await Promise.all([
    githubRequest(fetchImpl, token, `/releases/tags/${encodeURIComponent(plan.tag)}`, "release", { missing: true }),
    githubRequest(fetchImpl, token, "/releases/latest", "latest release", { missing: true }),
  ]);
  return {
    main,
    tag,
    release: normalizeRelease(releaseResponse),
    latest: normalizeRelease(latestResponse),
  };
}

export function verifyLocalReleaseCandidate(planValue, { root = ROOT } = {}) {
  const plan = validateReleasePlan(planValue);
  assertCleanCheckout(root, "release checkout after commit/tag");
  const head = gitObject(gitLine(root, ["rev-parse", "HEAD^{commit}"]), "local release commit");
  invariant(head !== plan.baseCommit, "release commit was not created");
  invariant(gitLine(root, ["show", "-s", "--format=%P", head]) === plan.baseCommit, "local release commit parent differs");
  invariant(gitLine(root, ["show", "-s", "--format=%T", head]) === plan.candidateTree, "local release commit tree differs");
  invariant(gitLine(root, ["show", "-s", "--format=%B", head]) === plan.commitMessage, "local release commit message differs");
  invariant(gitLine(root, ["cat-file", "-t", `refs/tags/${plan.tag}`]) === "tag", "local release tag is not annotated");
  invariant(gitLine(root, ["rev-parse", `refs/tags/${plan.tag}^{commit}`]) === head, "local release tag points elsewhere");
  return { mode: "push", releaseCommit: head };
}

function writeRemoteResult(stateFile, outputFile, state, classification) {
  writeExclusive(stateFile, jsonText({ ...state, classification }), "remote-state file");
  appendGithubOutputs(outputFile, {
    mode: classification.mode,
    "release-commit": classification.releaseCommit ?? "",
  });
}

function usage() {
  return [
    "usage:",
    "  release-coordinator.mjs prepare INTAKE_DIR ASSETS_DIR BASE_SHA PLAN.json NOTES.md GITHUB_OUTPUT",
    "  release-coordinator.mjs remote PLAN.json REMOTE.json GITHUB_OUTPUT",
    "  release-coordinator.mjs local PLAN.json GITHUB_OUTPUT",
    "  release-coordinator.mjs notes PLAN.json NOTES.md",
  ].join("\n");
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "prepare" && rest.length === 6) {
    const plan = await prepareReleaseCandidate({
      artifactDirectory: rest[0],
      assetsDirectory: rest[1],
      baseCommit: rest[2],
      planFile: rest[3],
      notesFile: rest[4],
      githubOutputFile: rest[5],
    });
    process.stdout.write(`${jsonText(plan)}`);
    return;
  }
  if (command === "remote" && rest.length === 3) {
    const plan = readReleasePlan(path.resolve(rest[0]));
    const state = await inspectRemoteRelease(plan, { token: process.env.GH_TOKEN });
    const classification = classifyRemoteRelease(plan, state);
    writeRemoteResult(rest[1], rest[2], state, classification);
    process.stdout.write(`${jsonText(classification)}`);
    return;
  }
  if (command === "local" && rest.length === 2) {
    const plan = readReleasePlan(path.resolve(rest[0]));
    const result = verifyLocalReleaseCandidate(plan);
    appendGithubOutputs(rest[1], {
      mode: result.mode,
      "release-commit": result.releaseCommit,
    });
    process.stdout.write(`${jsonText(result)}`);
    return;
  }
  if (command === "notes" && rest.length === 2) {
    const plan = readReleasePlan(path.resolve(rest[0]));
    const digest = verifyReleaseNotes(plan, path.resolve(rest[1]));
    process.stdout.write(`release notes verified: ${digest}\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release coordination failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
