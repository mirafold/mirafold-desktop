import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReleaseNotes } from "../scripts/verify-release-notes.mjs";

const exact = `## Included versions

- Mirafold Desktop \`1.2.3\`
- Mirafold Shell \`4.5.6\`

## What changed

Something useful.
`;

test("release notes contain one exact row for each included version", () => {
  assert.doesNotThrow(() => verifyReleaseNotes(exact, "1.2.3", "4.5.6"));
});

test("release notes reject contradictory version rows", () => {
  const contradictory = `${exact}\n- Mirafold Desktop \`0.1.0\`\n`;
  assert.throws(
    () => verifyReleaseNotes(contradictory, "1.2.3", "4.5.6"),
    /exactly one Mirafold Desktop row/,
  );
});

test("release notes reject Markdown-equivalent duplicate version rows", () => {
  for (const duplicate of [
    "   - Mirafold Desktop `0.1.0`",
    "* Mirafold Desktop `0.1.0`",
    "+ Mirafold Desktop `0.1.0`",
  ]) {
    assert.throws(
      () => verifyReleaseNotes(`${exact}\n${duplicate}\n`, "1.2.3", "4.5.6"),
      /exactly one Mirafold Desktop row/,
    );
  }
});

test("release notes reject Markdown-equivalent duplicate headings", () => {
  for (const duplicate of ["## Included versions ", "## Included versions ##"]) {
    assert.throws(
      () => verifyReleaseNotes(`${exact}\n${duplicate}\n`, "1.2.3", "4.5.6"),
      /exactly one ## Included versions heading/,
    );
  }
});

test("release notes reject matching rows outside the included-versions section", () => {
  const misplaced = exact.replace("- Mirafold Shell `4.5.6`\n", "") + "- Mirafold Shell `4.5.6`\n";
  assert.throws(
    () => verifyReleaseNotes(misplaced, "1.2.3", "4.5.6"),
    /must be inside ## Included versions/,
  );
});
