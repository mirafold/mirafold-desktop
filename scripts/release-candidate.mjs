#!/usr/bin/env node

// This contract runs beside the publisher's write token: standard library only,
// no candidate-supplied code, and all API paths come from validated identities.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, createReadStream, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseIdentity, expectedReleaseAssets } from "./release-contract.mjs";

export const REPOSITORY = "mirafold/mirafold-desktop";
export const WORKFLOW = ".github/workflows/release.yml";
export const MANIFEST = "candidate.json";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]*$/;

function validId(value) {
  assert.equal(typeof value, "string");
  assert.match(value, ID);
  assert.ok(Number.isSafeInteger(Number(value)), "unsafe GitHub identifier");
  return value;
}

// Parse the raw annotated tag object, not a formatted git log that might hide
// duplicate fields or read a lightweight tag's commit message instead.
export function parseCandidateTag(raw, tag, commit) {
  assert.match(commit, SHA);
  const boundary = raw.indexOf("\n\n");
  assert.ok(boundary > 0, "candidate selection requires an annotated tag");
  const header = raw.slice(0, boundary).split("\n");
  assert.equal(header[0], `object ${commit}`, "tag must name the candidate commit");
  assert.equal(header[1], "type commit");
  assert.equal(header[2], `tag ${tag}`);
  const message = raw.slice(boundary + 2).split("\n");
  function field(name, pattern) {
    const lines = message.filter((line) => line.startsWith(`${name}:`));
    assert.equal(lines.length, 1, `tag requires exactly one ${name}`);
    const value = lines[0].slice(name.length + 2);
    assert.equal(lines[0], `${name}: ${value}`);
    assert.match(value, pattern);
    return value;
  }
  return {
    runId: validId(field("Candidate-run", ID)),
    manifestSha256: field("Candidate-manifest-sha256", DIGEST),
  };
}

export function verifyCandidateRun(run, runId, commit) {
  validId(runId);
  assert.match(commit, SHA);
  assert.equal(run.id, Number(runId));
  assert.equal(run.repository?.full_name, REPOSITORY);
  assert.equal(run.head_repository?.full_name, REPOSITORY);
  assert.equal(run.path, WORKFLOW);
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "main");
  assert.equal(run.head_sha, commit);
  assert.equal(run.run_attempt, 1, "rerun candidates require a new freeze and acceptance");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
}

export function selectCandidateArtifact(artifacts, runId, commit) {
  const matches = artifacts.filter((artifact) => artifact.name === "release-candidate");
  assert.equal(matches.length, 1, "requires exactly one retained release-candidate artifact");
  const artifact = matches[0];
  validId(String(artifact.id));
  assert.equal(artifact.expired, false, "candidate artifact expired");
  assert.equal(artifact.workflow_run?.id, Number(runId));
  assert.equal(artifact.workflow_run?.head_sha, commit);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
  return String(artifact.id);
}

async function hashFile(file) {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "candidate files must be ordinary files");
  assert.ok(stat.size > 0 && Number.isSafeInteger(stat.size), "invalid candidate file size");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return { size: stat.size, sha256: digest.digest("hex") };
}

export async function describeCandidate(directory, identity, { hasManifest = false } = {}) {
  assert.equal(identity.repository, REPOSITORY);
  assert.equal(identity.workflow, WORKFLOW);
  assert.match(identity.commit, SHA);
  validId(identity.runId);
  assert.equal(identity.runAttempt, 1);
  assertReleaseIdentity(`v${identity.desktopVersion}`, identity.desktopVersion);
  assertReleaseIdentity(`v${identity.shellVersion}`, identity.shellVersion);
  const names = expectedReleaseAssets(identity.desktopVersion);
  // Flat inventory only; no recursive walk. Reject every extra name before
  // reading any content, including all opaque dotenv filename families.
  assert.deepEqual(readdirSync(directory).sort(), [...names, ...(hasManifest ? [MANIFEST] : [])].sort(),
    "candidate directory must contain only the exact approved files");
  const assets = [];
  for (const name of names) assets.push({ name, ...await hashFile(path.join(directory, name)) });
  return { schemaVersion: 1, ...identity, assets };
}

export async function verifyCandidate(directory, identity, manifestSha256) {
  assert.match(manifestSha256, DIGEST);
  const manifestPath = path.join(directory, MANIFEST);
  assert.ok(lstatSync(manifestPath).size <= 16_384, "candidate manifest too large");
  assert.equal((await hashFile(manifestPath)).sha256, manifestSha256, "accepted manifest hash differs");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, await describeCandidate(directory, identity, { hasManifest: true }),
    "candidate identity or accepted file hashes differ");
  return manifest;
}

function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }).trim();
}

function sourceIdentity(runId) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return {
    repository: REPOSITORY, workflow: WORKFLOW,
    commit: command("git", ["rev-parse", "HEAD"]),
    runId: validId(runId), runAttempt: 1,
    desktopVersion: pkg.version, shellVersion: pkg.dependencies.mirafold,
  };
}

function resolveCandidate() {
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  const tag = process.env.GITHUB_REF_NAME;
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assertReleaseIdentity(tag, pkg.version);
  assert.equal(process.env.GITHUB_REF, `refs/tags/${tag}`);
  command("git", ["fetch", "--no-tags", "--depth=1", "origin",
    "+refs/heads/main:refs/remotes/origin/main", `+refs/tags/${tag}:refs/tags/${tag}`]);
  const commit = command("git", ["rev-parse", "HEAD"]);
  assert.equal(commit, process.env.GITHUB_SHA);
  assert.equal(commit, command("git", ["rev-parse", "refs/remotes/origin/main"]), "tag must be main's current tip");
  const selection = parseCandidateTag(command("git", ["cat-file", "tag", `refs/tags/${tag}`]), tag, commit);
  const api = (suffix, args = []) => JSON.parse(command("gh", ["api", ...args, `repos/${REPOSITORY}/${suffix}`]));
  verifyCandidateRun(api(`actions/runs/${selection.runId}`), selection.runId, commit);
  const pages = api(`actions/runs/${selection.runId}/artifacts?per_page=100`, ["--paginate", "--slurp"]);
  const artifactId = selectCandidateArtifact(pages.flatMap((page) => page.artifacts), selection.runId, commit);
  return { ...selection, artifactId };
}

async function main([mode, directory, expectedRun, expectedDigest]) {
  if (mode === "create") {
    assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
    assert.equal(process.env.GITHUB_REF, "refs/heads/main");
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1", "start a new dispatch instead of rebuilding a candidate run");
    const identity = sourceIdentity(process.env.GITHUB_RUN_ID);
    assert.equal(identity.commit, process.env.GITHUB_SHA);
    const manifest = await describeCandidate(directory, identity);
    const manifestPath = path.join(directory, MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    const digest = (await hashFile(manifestPath)).sha256;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Candidate source: ${identity.commit}\n\nCandidate-run: ${identity.runId}\n\nCandidate-manifest-sha256: ${digest}\n`);
  } else if (mode === "resolve") {
    const selected = resolveCandidate();
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(selected).map(([key, value]) => `${key}=${value}\n`).join(""));
  } else if (mode === "verify") {
    // Repeat the live main/tag/run checks inside the protected job, after any
    // approval wait, and bind them to the earlier artifact selection.
    const selected = resolveCandidate();
    assert.equal(selected.runId, expectedRun);
    assert.equal(selected.manifestSha256, expectedDigest);
    await verifyCandidate(directory, sourceIdentity(selected.runId), selected.manifestSha256);
  } else {
    throw new Error("usage: release-candidate.mjs create DIR | resolve | verify DIR RUN_ID SHA256");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`candidate verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
