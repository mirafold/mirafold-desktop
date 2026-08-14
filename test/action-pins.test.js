import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflows = ["ci.yml", "release.yml", "shell-intake.yml"].map((name) => ({
  name,
  text: readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"),
}));

const reviewed = new Map([
  ["actions/checkout", { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" }],
  ["actions/setup-node", { sha: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0" }],
  ["actions/upload-artifact", { sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", version: "v7.0.1" }],
  ["actions/download-artifact", { sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", version: "v8.0.1" }],
  ["actions/attest", { sha: "1e69f48acb82d1966a394da916b4c1698aa569d6", version: "v4.2.2" }],
]);

test("every workflow action is one reviewed immutable commit with its release comment", () => {
  let uses = 0;
  for (const workflow of workflows) {
    for (const match of workflow.text.matchAll(/^\s*-?\s*uses:\s+([^@\s]+)@([^\s#]+)\s+#\s+(v\S+)\s*$/gm)) {
      uses += 1;
      const [, action, sha, version] = match;
      const expected = reviewed.get(action);
      assert.ok(expected, `${workflow.name} uses unreviewed action ${action}`);
      assert.equal(sha, expected.sha, `${workflow.name} does not pin ${action} to the reviewed commit`);
      assert.equal(version, expected.version, `${workflow.name} has a stale ${action} review comment`);
    }
    const rawUses = workflow.text.match(/^\s*-?\s*uses:/gm)?.length ?? 0;
    const reviewedUses = [...workflow.text.matchAll(/^\s*-?\s*uses:\s+[^@\s]+@[a-f0-9]{40}\s+#\s+v\S+\s*$/gm)].length;
    assert.equal(reviewedUses, rawUses, `${workflow.name} contains a moving or undocumented action reference`);
  }
  assert.ok(uses > 0, "no workflow actions were inspected");
});

// Pins the 2026-08-14 failure: `runner.temp` inside JOB-level `env:` is not a
// valid GitHub Actions context there — GitHub rejected every workflow carrying
// it at run creation ("Unrecognized named-value: 'runner'", a 0-second failure
// with no jobs), so pushes produced instant red runs and pull requests got no
// checks at all. The runner context is step-scoped. This check keys on the
// repository's fixed two-space indentation: job-level env entries sit at
// exactly six spaces, step-level entries deeper.
test("no workflow uses the runner context in job-level env", () => {
  let jobEnvEntries = 0;
  for (const workflow of workflows) {
    for (const line of workflow.text.split("\n")) {
      if (!/^ {6}[A-Z_]+:/.test(line)) continue;
      jobEnvEntries += 1;
      assert.doesNotMatch(
        line,
        /\$\{\{\s*runner\./,
        `${workflow.name} uses the runner context in job-level env: ${line.trim()}`,
      );
    }
  }
  assert.ok(jobEnvEntries > 0, "no job-level env entries were inspected");
});
