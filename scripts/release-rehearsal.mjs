#!/usr/bin/env node

// Deterministic, non-publishing rehearsal for the release state machine.
//
// Each check selects an exact test that drives the same repository-owned
// policy modules or workflow source used in production. Running this command
// performs no GitHub API call, Git write, package installation, or build; the
// separate manual Release workflow supplies native-runner proof while its
// publishing job is event-gated off.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function check(name, evidence) {
  return Object.freeze({
    name,
    evidence: Object.freeze(evidence.map(([file, test]) => Object.freeze({ file, test }))),
  });
}

export const RELEASE_REHEARSAL_CHECKS = Object.freeze([
  check("no-update", [[
    "test/shell-intake.test.js",
    "a no-update observation stays byte-identical and cannot produce a downstream artifact",
  ]]),
  check("one-update", [[
    "test/release-coordinator.test.js",
    "the writer reconstructs, stages, commits, and tags only the reviewed pair",
  ]]),
  check("rapid-two-update", [
    [
      "test/intake-workflow.test.js",
      "rapid Shell updates keep the active validation and coalesce to one newest pending run",
    ],
    [
      "test/release-coordinator.test.js",
      "a rapid second Shell update from the same base fails closed, then proceeds from current main",
    ],
  ]),
  check("failed-linux", [[
    "test/intake-workflow.test.js",
    "a failed Linux build cannot reach provenance or the release writer",
  ], [
    "test/workflow.test.js",
    "a manual linux failure rehearsal stops before dependency code",
  ]]),
  check("failed-windows", [[
    "test/intake-workflow.test.js",
    "a failed Windows build cannot reach provenance or the release writer",
  ], [
    "test/workflow.test.js",
    "a manual windows failure rehearsal stops before dependency code",
  ]]),
  check("stale-main", [[
    "test/release-coordinator.test.js",
    "stale main, competing candidates, and tag collisions fail closed",
  ]]),
  check("duplicate-run", [[
    "test/release-coordinator.test.js",
    "a duplicate schedule becomes an idempotent no-op only after a complete latest release",
  ]]),
  check("retry", [[
    "test/release-coordinator.test.js",
    "a retry resumes each safe post-push and draft state",
  ]]),
  check("no-publication", [
    ["test/workflow.test.js", "a manual release rehearsal cannot enter the publishing job"],
    [
      "test/intake-workflow.test.js",
      "the automated writer is dormant until explicitly enabled after every read-only gate",
    ],
  ]),
  check("exact-shell-identity", [
    [
      "test/shell-intake.test.js",
      "verified npm evidence is reduced to one exact immutable-candidate artifact",
    ],
    [
      "test/release-coordinator.test.js",
      "the writer reconstructs, stages, commits, and tags only the reviewed pair",
    ],
    [
      "test/packaged-smoke.test.js",
      "the packaged runtime resolves the daemon and loads both platform wrappers",
    ],
  ]),
]);

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePassingTests(output, name, label) {
  const pass = output.match(/^# pass (\d+)$/m);
  const fail = output.match(/^# fail (\d+)$/m);
  if (pass === null || Number(pass[1]) < 1 || fail === null || Number(fail[1]) !== 0) {
    throw new Error(`${label} returned no passing test summary`);
  }
  // `# pass 1` alone proves nothing about the named scenario: Node counts the
  // test FILE as one passing test, so a --test-name-pattern that matches no
  // test at all — a renamed or deleted evidence test — still reports one pass
  // (verified on Node 22, 2026-08-14). Only the named TAP result line proves
  // the referenced test really ran in this invocation.
  if (!new RegExp(`^ok \\d+ - ${escapeRegularExpression(name)}$`, "m").test(output)) {
    throw new Error(`${label} did not run the named test "${name}"`);
  }
  return Number(pass[1]);
}

export function runReleaseRehearsal({ root = ROOT, spawn = spawnSync } = {}) {
  const results = [];
  for (const rehearsal of RELEASE_REHEARSAL_CHECKS) {
    let passingTests = 0;
    for (const evidence of rehearsal.evidence) {
      const result = spawn(process.execPath, [
        "--test",
        `--test-name-pattern=^${escapeRegularExpression(evidence.test)}$`,
        evidence.file,
      ], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      });
      if (result.error) {
        throw new Error(`${rehearsal.name} could not run ${evidence.file}: ${result.error.message}`);
      }
      if (result.signal !== null || result.status !== 0) {
        const detail = String(result.stderr || result.stdout).trim().slice(-8000);
        throw new Error(
          `${rehearsal.name} failed ${evidence.file} (${result.signal ?? `exit ${result.status}`}): ${detail}`,
        );
      }
      passingTests += parsePassingTests(String(result.stdout), evidence.test, `${rehearsal.name} ${evidence.file}`);
    }
    results.push({
      name: rehearsal.name,
      status: "passed",
      evidenceCount: rehearsal.evidence.length,
      passingTests,
    });
  }
  return {
    schemaVersion: 1,
    mode: "local-no-network-no-publication",
    status: "passed",
    checks: results,
  };
}

function main(args) {
  if (args.length !== 0) throw new Error("usage: release-rehearsal.mjs");
  process.stdout.write(`${JSON.stringify(runReleaseRehearsal(), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release rehearsal failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
