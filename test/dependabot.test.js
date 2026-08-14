import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const policy = readFileSync(
  new URL("../.github/dependabot.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

test("Dependabot reviews npm and immutable GitHub Action pins every week", () => {
  assert.equal(policy.match(/package-ecosystem: npm/g)?.length, 1);
  assert.equal(policy.match(/package-ecosystem: github-actions/g)?.length, 1);
  assert.equal(policy.match(/interval: weekly/g)?.length, 2);
  assert.equal(policy.match(/open-pull-requests-limit: 5/g)?.length, 2);
});

test("routine Shell movement stays owned by intake without suppressing security updates", () => {
  assert.match(policy, /dependency-name: mirafold/);
  for (const type of ["major", "minor", "patch"]) {
    assert.match(policy, new RegExp(`version-update:semver-${type}`));
  }
  assert.doesNotMatch(policy, /versions:/);
});
