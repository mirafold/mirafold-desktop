import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

test("CI supplies stable Linux and Windows checks for main and pull requests", () => {
  const header = workflow.slice(0, workflow.indexOf("\njobs:"));
  assert.match(header, /push:\s*\n\s+branches: \[main\]/);
  assert.match(header, /pull_request:\s*\n\s+branches: \[main\]/);
  assert.match(header, /workflow_dispatch:/);
  assert.doesNotMatch(header, /pull_request_target/);
  assert.match(workflow, /name: test \(\$\{\{ matrix\.name \}\}\)/);
  assert.match(workflow, /name: linux\s*\n\s+os: ubuntu-latest/);
  assert.match(workflow, /name: windows\s*\n\s+os: windows-latest/);
});

test("CI is read-only and leaves no checkout credential for dependency code", () => {
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /id-token: write/);
  assert.match(workflow, /persist-credentials: false/);
});

test("both CI platforms use the exact toolchain and verify dependencies before tests", () => {
  const installTool = workflow.indexOf("npm install --global npm@12.0.2");
  const installTree = workflow.indexOf("npm ci --ignore-scripts");
  const list = workflow.indexOf("npm ls --all");
  const audit = workflow.indexOf("npm audit --audit-level=moderate");
  const signatures = workflow.indexOf("npm audit signatures --include-attestations");
  const tests = workflow.indexOf("\n          npm test\n");
  assert.ok(installTool !== -1 && installTool < installTree);
  assert.ok(installTree < list && list < audit && audit < signatures && signatures < tests);
  assert.match(workflow, /test "\$\(npm --version\)" = "12\.0\.2"/);
  assert.doesNotMatch(workflow, /cache:/);
  assert.doesNotMatch(workflow, /\bnpx\b/);
});
