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
    /must declare Mirafold versions only in the leading ## Included versions block/,
  );
});

test("release notes reject Markdown-equivalent duplicate version rows", () => {
  for (const duplicate of [
    "   - Mirafold Desktop `0.1.0`",
    "* Mirafold Desktop `0.1.0`",
    "+ Mirafold Desktop `0.1.0`",
    "- Mirafold **Desktop** `0.1.0`",
    "- **Mirafold Desktop** `0.1.0`",
    "- Mirafold [Desktop](https://example.invalid) `0.1.0`",
    "- Mira**fold Desktop** `0.1.0`",
    "- Mirafold Desktop\n  `0.1.0`",
  ]) {
    assert.throws(
      () => verifyReleaseNotes(`${exact}\n${duplicate}\n`, "1.2.3", "4.5.6"),
      /must declare Mirafold versions only in the leading ## Included versions block/,
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

test("release notes reject a version block enclosed in a Markdown fence", () => {
  const fenced = `~~~text\n${exact}~~~\n`;
  assert.throws(
    () => verifyReleaseNotes(fenced, "1.2.3", "4.5.6"),
    /must begin with the exact ## Included versions block/,
  );
});

test("release notes reject rows outside the leading included-versions block", () => {
  for (const boundary of ["# Different top-level section", "## Different section"]) {
    const misplaced = `## Included versions

- Mirafold Desktop \`1.2.3\`

${boundary}

- Mirafold Shell \`4.5.6\`
`;
    assert.throws(
      () => verifyReleaseNotes(misplaced, "1.2.3", "4.5.6"),
      /must begin with the exact ## Included versions block/,
    );
  }
});
