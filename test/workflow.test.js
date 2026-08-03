// Pins the 2026-08-03 audit finding: the release workflow granted
// `contents: write` at the top level, so the build job — which runs `npm ci`
// and electron-builder, i.e. code from ~400 packages — held a token that could
// push to the repo or replace release assets. Job-level scopes now split it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Normalized to LF: a Windows runner checks this repo out with CRLF endings,
// and the line-anchored searches below would find nothing.
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  .split("\r\n")
  .join("\n");

/** The text of one top-level job block, by name. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\w[\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("the build job cannot write to the repo", () => {
  const build = job("build");
  assert.match(build, /permissions:\s*\n\s+contents: read/, "build job needs contents: read");
  assert.doesNotMatch(build, /contents: write/, "build job must never hold a write token");
});

test("the build job does not leave a credential on disk", () => {
  assert.match(job("build"), /persist-credentials: false/);
});

test("only the release job may write", () => {
  assert.match(job("release"), /permissions:\s*\n\s+contents: write/);
});

test("the workflow default is read-only", () => {
  const header = workflow.slice(0, workflow.indexOf("\njobs:"));
  assert.match(header, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(header, /contents: write/);
});

test("no fork-triggered run can reach these permissions", () => {
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /\bpull_request\b/);
});
