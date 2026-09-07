import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { expectedReleaseAssets } from "../scripts/release-contract.mjs";
import { describeCandidate, verifyCandidate, parseCandidateTag, verifyCandidateRun,
  selectCandidateArtifact, REPOSITORY, WORKFLOW, MANIFEST } from "../scripts/release-candidate.mjs";

const commit = "a".repeat(40);
const identity = { repository: REPOSITORY, workflow: WORKFLOW, commit,
  runId: "123", runAttempt: 1, desktopVersion: "0.4.0", shellVersion: "0.9.0" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t, value = identity) {
  const directory = mkdtempSync(path.join(tmpdir(), "desktop-candidate-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of expectedReleaseAssets(value.desktopVersion)) {
    writeFileSync(path.join(directory, name), `original bytes: ${name}`);
  }
  return directory;
}
async function seal(directory, value = identity) {
  const bytes = `${JSON.stringify(await describeCandidate(directory, value), null, 2)}\n`;
  writeFileSync(path.join(directory, MANIFEST), bytes);
  return hash(bytes);
}

test("candidate verification accepts exactly the selected identity and all 17 original files", async (t) => {
  const directory = fixture(t);
  const digest = await seal(directory);
  const actual = await verifyCandidate(directory, identity, digest);
  assert.equal(actual.assets.length, 17);
  assert.deepEqual(actual.assets.map((asset) => asset.name), expectedReleaseAssets("0.4.0"));
});

test("candidate verification refuses changed bytes in every accepted file even at the same size", async (t) => {
  const directory = fixture(t);
  const digest = await seal(directory);
  for (const name of expectedReleaseAssets("0.4.0")) {
    const file = path.join(directory, name);
    const original = readFileSync(file);
    const changed = Buffer.from(original);
    changed[0] ^= 1;
    writeFileSync(file, changed);
    await assert.rejects(verifyCandidate(directory, identity, digest), /hashes differ/, name);
    writeFileSync(file, original);
  }
  await verifyCandidate(directory, identity, digest);
});

test("candidate verification refuses missing, extra and non-file entries before promotion", async (t) => {
  const directory = fixture(t);
  const digest = await seal(directory);
  const file = path.join(directory, expectedReleaseAssets("0.4.0")[0]);
  renameSync(file, `${file}.missing`);
  await assert.rejects(verifyCandidate(directory, identity, digest), /exact approved files/);
  renameSync(`${file}.missing`, file);
  writeFileSync(path.join(directory, "unexpected.txt"), "must not upload");
  await assert.rejects(verifyCandidate(directory, identity, digest), /exact approved files/);
  rmSync(path.join(directory, "unexpected.txt"));
  const bytes = readFileSync(file);
  rmSync(file);
  mkdirSync(file);
  await assert.rejects(verifyCandidate(directory, identity, digest), /ordinary files/);
  rmSync(file, { recursive: true });
  writeFileSync(file, bytes);
  await verifyCandidate(directory, identity, digest);
});

test("candidate verification rejects symlinked payload and manifest", { skip: process.platform === "win32" }, async (t) => {
  const directory = fixture(t);
  const digest = await seal(directory);
  for (const name of [expectedReleaseAssets("0.4.0")[0], MANIFEST]) {
    const file = path.join(directory, name);
    const saved = `${directory}-${name}`;
    renameSync(file, saved);
    try {
      symlinkSync(saved, file);
      await assert.rejects(verifyCandidate(directory, identity, digest), /ordinary files/);
    } finally {
      rmSync(file);
      renameSync(saved, file);
    }
  }
});

test("candidate manifest cannot be replaced or rebound to another source, run, or version", async (t) => {
  const directory = fixture(t);
  const digest = await seal(directory);
  await assert.rejects(verifyCandidate(directory, identity, "b".repeat(64)), /manifest hash differs/);
  for (const [key, value] of Object.entries({ commit: "b".repeat(40), runId: "124", runAttempt: 2,
    repository: "attacker/fork", workflow: ".github/workflows/ci.yml", desktopVersion: "0.4.1", shellVersion: "0.9.1" })) {
    await assert.rejects(verifyCandidate(directory, { ...identity, [key]: value }, digest), undefined, key);
  }
  const file = path.join(directory, MANIFEST);
  const original = readFileSync(file);
  const changed = Buffer.from(original.toString().replace('"schemaVersion": 1', '"schemaVersion": 2'));
  writeFileSync(file, changed);
  await assert.rejects(verifyCandidate(directory, identity, digest), /manifest hash differs/);
  await assert.rejects(verifyCandidate(directory, identity, hash(changed)), /hashes differ/);
});

test("only a successful first candidate dispatch on the same canonical main commit is eligible", () => {
  const run = { id: 123, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
    path: WORKFLOW, event: "workflow_dispatch", head_branch: "main", head_sha: commit,
    run_attempt: 1, status: "completed", conclusion: "success" };
  verifyCandidateRun(run, "123", commit);
  for (const [key, values] of Object.entries({ id: [124, "123"], repository: [{ full_name: "attacker/fork" }, null],
    head_repository: [{ full_name: "attacker/fork" }], path: [".github/workflows/ci.yml"], event: ["push", "pull_request"],
    head_branch: ["next"], head_sha: ["b".repeat(40)], run_attempt: [2], status: ["in_progress"],
    conclusion: ["failure", "cancelled", "skipped", null] })) {
    for (const value of values) assert.throws(() => verifyCandidateRun({ ...run, [key]: value }, "123", commit), undefined, key);
  }
});

test("candidate artifact selection rejects missing, duplicate, expired and cross-run artifacts", () => {
  const artifact = { id: 456, name: "release-candidate", expired: false, digest: `sha256:${"a".repeat(64)}`,
    workflow_run: { id: 123, head_sha: commit } };
  assert.equal(selectCandidateArtifact([{ name: "linux" }, artifact], "123", commit), "456");
  for (const values of [[], [artifact, artifact], [{ ...artifact, expired: true }],
    [{ ...artifact, workflow_run: { id: 124, head_sha: commit } }],
    [{ ...artifact, workflow_run: { id: 123, head_sha: "b".repeat(40) } }],
    [{ ...artifact, digest: null }], [{ ...artifact, id: -1 }]]) {
    assert.throws(() => selectCandidateArtifact(values, "123", commit));
  }
});

test("annotated release tags must name one exact candidate run and accepted manifest digest", () => {
  const header = `object ${commit}\ntype commit\ntag v0.4.0\ntagger Example\n\n`;
  const message = `Desktop v0.4.0\n\nCandidate-run: 123\nCandidate-manifest-sha256: ${"a".repeat(64)}\n`;
  assert.deepEqual(parseCandidateTag(header + message, "v0.4.0", commit), { runId: "123", manifestSha256: "a".repeat(64) });
  for (const raw of [message, header + "no selection", header + message + "Candidate-run: 123\n",
    header + message + `Candidate-manifest-sha256: ${"a".repeat(64)}\n`,
    (header + message).replace("run: 123", "run: 00123"),
    (header + message).replace("run: 123", "run: 123; echo injected"),
    (header + message).replace("run: 123", "run: 9007199254740992"),
    (header + message).replace("sha256: a", "sha256: z"),
    (header + message).replace(`object ${commit}`, `object ${"b".repeat(40)}`),
    (header + message).replace("type commit", "type tag"),
    (header + message).replace("tag v0.4.0", "tag v0.4.1")]) {
    assert.throws(() => parseCandidateTag(raw, "v0.4.0", commit));
  }
});

test("candidate create command binds the checkout and fails closed outside a first main dispatch", async (t) => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const value = { ...identity, desktopVersion: pkg.version, shellVersion: pkg.dependencies.mirafold };
  const directory = fixture(t, value);
  const script = fileURLToPath(new URL("../scripts/release-candidate.mjs", import.meta.url));
  const root = path.dirname(path.dirname(script));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const summary = `${directory}-summary`;
  t.after(() => rmSync(summary, { force: true }));
  const env = { ...process.env, GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "123", GITHUB_SHA: sha,
    GITHUB_STEP_SUMMARY: summary };
  for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: "attacker/fork", GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/next", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "b".repeat(40) })) {
    assert.throws(() => execFileSync(process.execPath, [script, "create", directory],
      { cwd: root, env: { ...env, [key]: value }, stdio: "pipe" }), undefined, key);
  }
  execFileSync(process.execPath, [script, "create", directory], { cwd: root, env, stdio: "pipe" });
  const digest = hash(readFileSync(path.join(directory, MANIFEST)));
  await verifyCandidate(directory, { ...value, commit: sha }, digest);
  assert.match(readFileSync(summary, "utf8"), new RegExp(`Candidate-manifest-sha256: ${digest}`));
  assert.throws(() => execFileSync(process.execPath, [script, "create", directory], { cwd: root, env, stdio: "pipe" }));
});

test("promotion commands recheck live main and bind the downloaded run and accepted digest", { skip: process.platform === "win32" }, async (t) => {
  // The production publisher is Linux. Exercise its real git/tag/API command
  // wiring in a private repository; only GitHub's remote API is substituted.
  const root = mkdtempSync(path.join(tmpdir(), "desktop-promotion-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, "assets"));
  const project = fileURLToPath(new URL("..", import.meta.url));
  for (const file of ["package.json", "scripts/release-candidate.mjs", "scripts/release-contract.mjs", "scripts/apt-repository.mjs"]) {
    copyFileSync(path.join(project, file), path.join(root, file));
  }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GH_FIXTURE: path.join(root, "api.json"), GH_CALLS: path.join(root, "api-calls.txt"),
    PATH: `${path.join(root, "bin")}:${process.env.PATH}` };
  const git = (...args) => execFileSync("git", ["-c", "user.name=Candidate test", "-c", "user.email=candidate@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("add", "package.json", "scripts/release-candidate.mjs", "scripts/release-contract.mjs", "scripts/apt-repository.mjs");
  git("commit", "-m", "isolated candidate source");
  const sha = git("rev-parse", "HEAD");
  git("remote", "add", "origin", root);
  git("checkout", "--detach", sha);
  const value = { ...identity, commit: sha, desktopVersion: pkg.version, shellVersion: pkg.dependencies.mirafold };
  const directory = path.join(root, "assets");
  for (const name of expectedReleaseAssets(pkg.version)) writeFileSync(path.join(directory, name), `accepted: ${name}`);
  const digest = await seal(directory, value);
  const tag = `v${pkg.version}`;
  git("tag", "-a", tag, "-m", `Release\n\nCandidate-run: 123\nCandidate-manifest-sha256: ${digest}`);
  const run = { id: 123, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
    path: WORKFLOW, event: "workflow_dispatch", head_branch: "main", head_sha: sha,
    run_attempt: 1, status: "completed", conclusion: "success" };
  const artifact = { id: 456, name: "release-candidate", expired: false, digest: `sha256:${"a".repeat(64)}`,
    workflow_run: { id: 123, head_sha: sha } };
  const api = { [`repos/${REPOSITORY}/actions/runs/123`]: run,
    [`repos/${REPOSITORY}/actions/runs/123/artifacts?per_page=100`]: [{ artifacts: [{ name: "linux" }] }, { artifacts: [artifact] }] };
  writeFileSync(env.GH_FIXTURE, JSON.stringify(api));
  writeFileSync(path.join(root, "bin", "gh"), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'api') process.exit(31);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n');
const value = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'))[args.at(-1)];
if (!value) process.exit(32);
process.stdout.write(JSON.stringify(value));
`, { mode: 0o700 });
  const commandEnv = { ...env, GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "push",
    GITHUB_REF: `refs/tags/${tag}`, GITHUB_REF_NAME: tag, GITHUB_SHA: sha, GITHUB_OUTPUT: path.join(root, "outputs") };
  const invoke = (...args) => execFileSync(process.execPath, [path.join(root, "scripts/release-candidate.mjs"), ...args],
    { cwd: root, env: commandEnv, encoding: "utf8", stdio: "pipe" });
  invoke("resolve");
  assert.equal(readFileSync(commandEnv.GITHUB_OUTPUT, "utf8"), `runId=123\nmanifestSha256=${digest}\nartifactId=456\n`);
  invoke("verify", directory, "123", digest);
  assert.throws(() => invoke("verify", directory, "124", digest));
  assert.throws(() => invoke("verify", directory, "123", "b".repeat(64)));
  run.conclusion = "failure";
  writeFileSync(env.GH_FIXTURE, JSON.stringify(api));
  assert.throws(() => invoke("verify", directory, "123", digest));
  run.conclusion = "success";
  writeFileSync(env.GH_FIXTURE, JSON.stringify(api));
  const newer = git("commit-tree", `${sha}^{tree}`, "-p", sha, "-m", "main advanced after selection");
  git("update-ref", "refs/heads/main", newer);
  assert.throws(() => invoke("resolve"));
  assert.throws(() => invoke("verify", directory, "123", digest));
  git("update-ref", "refs/heads/main", sha);
  invoke("verify", directory, "123", digest);
  const calls = readFileSync(env.GH_CALLS, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((args) => args.includes("--paginate") && args.includes("--slurp")));
});
