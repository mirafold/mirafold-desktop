import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELEASE_REHEARSAL_CHECKS,
  runReleaseRehearsal,
} from "../scripts/release-rehearsal.mjs";

test("the release rehearsal maps every named scenario and safety invariant to passing tests", () => {
  assert.deepEqual(RELEASE_REHEARSAL_CHECKS.map((check) => check.name), [
    "no-update",
    "one-update",
    "rapid-two-update",
    "failed-linux",
    "failed-windows",
    "stale-main",
    "duplicate-run",
    "retry",
    "no-publication",
    "exact-shell-identity",
  ]);
  const invocations = [];
  const report = runReleaseRehearsal({
    spawn(executable, args, options) {
      invocations.push({ executable, args, options });
      return {
        error: undefined,
        signal: null,
        status: 0,
        stdout: [
          "TAP version 13",
          "1..1",
          "# tests 1",
          "# pass 1",
          "# fail 0",
          "# skipped 0",
          "",
        ].join("\n"),
        stderr: "",
      };
    },
  });
  assert.equal(report.mode, "local-no-network-no-publication");
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, RELEASE_REHEARSAL_CHECKS.length);
  assert.ok(report.checks.every((check) => check.status === "passed"));
  assert.ok(report.checks.every((check) => check.passingTests >= check.evidenceCount));
  assert.equal(
    invocations.length,
    RELEASE_REHEARSAL_CHECKS.reduce((total, check) => total + check.evidence.length, 0),
  );
  assert.ok(invocations.every(({ executable }) => executable === process.execPath));
  assert.ok(invocations.every(({ args }) => args[0] === "--test"));
  assert.ok(invocations.every(({ args }) => args[1].startsWith("--test-name-pattern=^")));
  assert.ok(invocations.every(({ options }) => options.shell === false));
});
