import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const releasing = readFileSync(
  new URL("../docs/RELEASING.md", import.meta.url),
  "utf8",
);

test("manual release prep stages version-bound release notes", () => {
  const prep = releasing.match(/3\. \*\*Write the release notes[\s\S]*?(?=\n4\. )/)?.[0];

  assert.ok(prep, "manual release-note preparation is missing");
  for (const required of [
    ".github/RELEASE_NOTES.md",
    "## Included versions",
    "- Mirafold Desktop `DESKTOP_VERSION`",
    "- Mirafold Shell `BUNDLED_SHELL_VERSION`",
    "dependencies.mirafold",
    "git add .github/RELEASE_NOTES.md package.json package-lock.json",
  ]) {
    assert.ok(prep.includes(required), `manual release prep is missing: ${required}`);
  }
});

test("the release closeout reconstructs production as one signed-off next commit", () => {
  const closeout = releasing.match(
    /8\. \*\*Close the loop[\s\S]*?(?=\n9\. )/,
  )?.[0];

  assert.ok(closeout, "manual release closeout section is missing");
  assert.doesNotMatch(
    closeout,
    /git push origin origin\/main:refs\/heads\/sync\/main-into-next/,
    "the sync branch must not expose main's divergent commit ancestry to DCO",
  );
  for (const command of [
    "git switch -c sync/main-into-next-vx.y.z origin/next",
    "git diff --binary origin/next origin/main | git apply --index",
    "git diff --cached --quiet origin/main",
    "git diff --quiet",
    'git commit -s -m "sync: main into next after vx.y.z"',
  ]) {
    assert.ok(closeout.includes(command), `release closeout is missing: ${command}`);
  }
  assert.match(
    closeout,
    /Keep `next` closed to new\s+merges/,
    "the runbook must prevent a sync from erasing newer staging work",
  );
});
