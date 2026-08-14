import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/shell-intake.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const intakeSource = readFileSync(
  new URL("../scripts/shell-intake.mjs", import.meta.url),
  "utf8",
);
const preparationSource = readFileSync(
  new URL("../scripts/prepare-shell-release.mjs", import.meta.url),
  "utf8",
);
const coordinatorSource = readFileSync(
  new URL("../scripts/release-coordinator.mjs", import.meta.url),
  "utf8",
);
const releaseContractSource = readFileSync(
  new URL("../scripts/release-contract.mjs", import.meta.url),
  "utf8",
);

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\w[\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function withoutComments(value) {
  return value
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

test("Shell intake is scheduled twice hourly, manually dispatchable, and serialized", () => {
  const header = workflow.slice(0, workflow.indexOf("\njobs:"));
  const executable = withoutComments(header);
  assert.match(executable, /schedule:\s*\n\s+- cron: "17,47 \* \* \* \*"/);
  assert.match(header, /workflow_dispatch:/);
  assert.match(header, /concurrency:\s*\n\s+group: mirafold-shell-intake\s*\n\s+cancel-in-progress: false/);
  assert.doesNotMatch(header, /\bpush:/);
  assert.doesNotMatch(header, /pull_request/);
});

test("rapid Shell updates keep the active validation and coalesce to one newest pending run", () => {
  const header = workflow.slice(0, workflow.indexOf("\njobs:"));
  assert.match(
    header,
    /concurrency:\s*\n\s+group: mirafold-shell-intake\s*\n\s+cancel-in-progress: false/,
  );
  assert.doesNotMatch(header, /cancel-in-progress: true/);
});

test("dependency and build jobs are read-only; only the isolated writer can push", () => {
  const header = workflow.slice(0, workflow.indexOf("\njobs:"));
  assert.match(header, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(header, /contents: write/);
  for (const name of ["intake", "test", "build"]) {
    const value = job(name);
    assert.match(value, /permissions:\s*\n\s+contents: read/);
    assert.match(value, /persist-credentials: false/);
    assert.doesNotMatch(value, /contents: write/);
  }
  const writer = job("release");
  assert.match(writer, /permissions:\s*\n\s+contents: write/);
  assert.match(writer, /persist-credentials: true/);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
});

test("manual intake is restricted to the canonical repository main branch before npm runs", () => {
  const intake = withoutComments(job("intake"));
  const repository = intake.indexOf('test "$INTAKE_REPOSITORY" = "mirafold/mirafold-desktop"');
  const branch = intake.indexOf('test "$INTAKE_REF" = "refs/heads/main"');
  const npm = intake.indexOf("npm install --global");
  const prepare = intake.indexOf("shell-intake.mjs prepare");
  assert.ok(repository !== -1 && branch !== -1 && repository < npm && branch < npm);
  assert.ok(npm < prepare);
});

test("the workflow uses package.json's exact npm toolchain with scripts disabled", () => {
  assert.equal(packageMetadata.packageManager, "npm@12.0.2");
  assert.equal(workflow.match(/npm install --global npm@12\.0\.2/g)?.length, 3);
  assert.equal(workflow.match(/test "\$\(npm --version\)" = "12\.0\.2"/g)?.length, 3);
  assert.equal(workflow.match(/NPM_CONFIG_IGNORE_SCRIPTS: "true"/g)?.length, 3);
  assert.equal(workflow.match(/NPM_CONFIG_REGISTRY: https:\/\/registry\.npmjs\.org/g)?.length, 3);
  assert.equal(
    workflow.match(/export NPM_CONFIG_USERCONFIG="\$RUNNER_TEMP\/mirafold-empty-npmrc"/g)?.length,
    3,
    "each npm job must create its isolated user config at step level",
  );
});

test("unverified package bytes cannot cross the intake boundary", () => {
  const intake = job("intake");
  const executable = withoutComments(intake);
  const prepare = executable.indexOf("shell-intake.mjs prepare");
  const materialize = executable.indexOf("npm ci --ignore-scripts");
  const signatures = executable.indexOf("npm audit signatures --json --include-attestations");
  const verify = executable.indexOf("shell-intake.mjs verify");
  const upload = executable.indexOf("uses: actions/upload-artifact@");
  assert.ok(prepare !== -1 && prepare < materialize);
  assert.ok(materialize < signatures && signatures < verify && verify < upload);
  assert.doesNotMatch(executable, /\bnpm test\b/);
  assert.match(executable, /if: steps\.prepare\.outputs\.changed == 'true'/);
});

test("only the two reviewed manifests and compact evidence are retained", () => {
  const intake = withoutComments(job("intake"));
  const upload = intake.slice(intake.indexOf("uses: actions/upload-artifact@"));
  for (const file of ["package.json", "package-lock.json", "shell-intake.json"]) {
    assert.match(upload, new RegExp(`mirafold-shell-intake-artifact/${file.replace(".", "\\.")}`));
  }
  assert.doesNotMatch(upload, /node_modules/);
  assert.doesNotMatch(upload, /mirafold-npm-signatures\.json/);
  assert.doesNotMatch(upload, /mirafold-shell-intake-state\.json/);
  assert.match(upload, /if-no-files-found: error/);
  assert.match(upload, /include-hidden-files: false/);
});

test("tests consume the immutable reviewed artifact only after intake succeeds", () => {
  const value = withoutComments(job("test"));
  assert.match(value, /needs: intake/);
  assert.match(value, /if: needs\.intake\.outputs\.changed == 'true'/);
  const download = value.indexOf("uses: actions/download-artifact@");
  const apply = value.indexOf("shell-intake.mjs apply");
  const install = value.indexOf("npm ci --ignore-scripts");
  const audit = value.indexOf("npm audit --audit-level=moderate");
  const tests = value.indexOf("npm test");
  const check = value.indexOf("shell-intake.mjs check");
  assert.ok(download !== -1 && download < apply);
  assert.ok(apply < install && install < audit && audit < tests && tests < check);
  assert.match(value, /name: mirafold-shell-intake/);
});

test("the intake policy implementation loads no third-party code", () => {
  const intakeImports = [...intakeSource.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    intakeImports.filter((specifier) => !specifier.startsWith("node:")),
    ["./prepare-shell-release.mjs"],
  );
  const preparationImports = [...preparationSource.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.deepEqual(
    preparationImports.filter((specifier) => !specifier.startsWith("node:")),
    [],
  );
});

test("native Linux and Windows builds consume, test, smoke, and retain one reviewed candidate", () => {
  const value = withoutComments(job("build"));
  assert.match(value, /needs: \[intake, test\]/);
  assert.match(value, /if: needs\.intake\.outputs\.changed == 'true'/);
  assert.match(value, /name: linux\s*\n\s+os: ubuntu-latest\s*\n\s+args: --linux/);
  assert.match(value, /name: windows\s*\n\s+os: windows-latest\s*\n\s+args: --win/);
  const download = value.indexOf("name: mirafold-shell-intake");
  const apply = value.indexOf("shell-intake.mjs apply");
  const install = value.indexOf("npm ci --ignore-scripts");
  const signatures = value.indexOf("npm audit signatures --include-attestations");
  const tests = value.indexOf("npm test");
  const packageApp = value.indexOf("node_modules/electron-builder/cli.js");
  const smoke = value.indexOf("packaged-smoke.mjs");
  const installedSmoke = value.indexOf("windows-installer-smoke.mjs");
  const manifest = value.indexOf("release-contract.mjs manifest");
  const contract = value.indexOf("release-contract.mjs platform");
  const check = value.indexOf("shell-intake.mjs check");
  const upload = value.indexOf("uses: actions/upload-artifact@");
  assert.ok(download !== -1 && download < apply);
  assert.ok(apply < install && install < signatures && signatures < tests && tests < packageApp);
  assert.ok(
    packageApp < smoke
      && smoke < installedSmoke
      && installedSmoke < manifest
      && manifest < contract
      && contract < check
      && check < upload,
  );
  assert.match(value, /if: matrix\.name == 'windows'\s*\n\s+run: node scripts\/windows-installer-smoke\.mjs dist/);
  assert.doesNotMatch(value, /\bnpx\b/);
  assert.match(value, /name: mirafold-release-\$\{\{ matrix\.name \}\}/);
  for (const pattern of ["dist/SHA256SUMS-*.txt", "dist/latest*.yml", "dist/*.blockmap", "dist/*.deb", "dist/*.tar.gz", "dist/*.AppImage", "dist/*.exe"]) {
    assert.ok(value.includes(pattern), `native artifact upload omits ${pattern}`);
  }
});

for (const [platform, runner] of [["Linux", "ubuntu-latest"], ["Windows", "windows-latest"]]) {
  test(`a failed ${platform} build cannot reach provenance or the release writer`, () => {
    const build = withoutComments(job("build"));
    const attest = withoutComments(job("attest"));
    const release = withoutComments(job("release"));
    assert.match(build, /fail-fast: false/);
    assert.ok(build.includes(`os: ${runner}`), `${platform} matrix runner is missing`);
    assert.match(attest, /needs: \[intake, test, build\]/);
    assert.doesNotMatch(attest, /always\(\)/);
    assert.match(release, /needs: \[intake, test, build, attest\]/);
    assert.doesNotMatch(release, /always\(\)/);
  });
}

test("the automated writer is dormant until explicitly enabled after every read-only gate", () => {
  const value = job("release");
  assert.match(value, /needs: \[intake, test, build, attest\]/);
  assert.match(value, /needs\.intake\.outputs\.changed == 'true'/);
  assert.match(value, /vars\.MIRAFOLD_AUTOMATED_RELEASES == 'enabled'/);
  assert.match(value, /environment: automated-release/);
  assert.match(value, /concurrency:\s*\n\s+group: mirafold-desktop-publication\s*\n\s+cancel-in-progress: false/);
});

test("provenance is isolated, verifies the reviewed nine-file candidate, and cannot publish", () => {
  const value = withoutComments(job("attest"));
  assert.match(value, /needs: \[intake, test, build\]/);
  assert.match(value, /needs\.intake\.outputs\.changed == 'true'/);
  assert.match(value, /vars\.MIRAFOLD_AUTOMATED_RELEASES == 'enabled'/);
  assert.match(value, /github\.event_name == 'workflow_dispatch'/);
  assert.match(value, /contents: read/);
  assert.match(value, /id-token: write/);
  assert.match(value, /attestations: write/);
  assert.match(value, /artifact-metadata: write/);
  assert.doesNotMatch(value, /contents: write/);
  const intakeDownload = value.indexOf("name: mirafold-shell-intake");
  const assetDownload = value.indexOf("pattern: mirafold-release-*");
  const apply = value.indexOf("shell-intake.mjs apply");
  const verify = value.indexOf("release-contract.mjs complete");
  const attest = value.indexOf("uses: actions/attest@");
  assert.ok(intakeDownload !== -1 && intakeDownload < assetDownload && assetDownload < apply);
  assert.ok(apply < verify && verify < attest);
  assert.match(value, /subject-path: \$\{\{ runner\.temp \}\}\/mirafold-release-assets\/\*/);
  assert.doesNotMatch(value, /\bnpm\s+(?:ci|install|test|run)\b/);
  assert.doesNotMatch(value, /\bnpx\b/);
});

test("the write-capable job loads no installed dependency code", () => {
  const writer = withoutComments(job("release"));
  assert.doesNotMatch(writer, /\bnpm\s+(?:ci|install|test|run)\b/);
  assert.doesNotMatch(writer, /\bnpx\b/);
  const imports = [coordinatorSource, intakeSource, preparationSource, releaseContractSource]
    .flatMap((source) => [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]));
  assert.deepEqual(
    imports.filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("./")),
    [],
  );
});

test("the writer pushes branch and annotated tag together, then publishes only a verified draft", () => {
  const value = withoutComments(job("release"));
  const prepare = value.indexOf("release-coordinator.mjs prepare");
  const preflight = value.indexOf("release-coordinator.mjs remote");
  const commit = value.indexOf('commit -m "$RELEASE_COMMIT_MESSAGE"');
  const tag = value.indexOf('tag -a "$RELEASE_TAG"');
  const local = value.indexOf("release-coordinator.mjs local");
  const push = value.indexOf("git push --atomic origin");
  const remote = value.indexOf("release-coordinator.mjs remote", preflight + 1);
  const notes = value.indexOf("release-coordinator.mjs notes");
  const draft = value.indexOf('gh release create "$RELEASE_TAG"');
  const upload = value.indexOf('gh release upload "$RELEASE_TAG"');
  const verifyDraft = value.indexOf("release-contract.mjs draft");
  const publish = value.indexOf('gh release edit "$RELEASE_TAG"');
  const verifyPublic = value.indexOf("release-contract.mjs published");
  assert.ok(prepare !== -1 && prepare < preflight && preflight < commit);
  assert.ok(commit < tag && tag < local && local < push && push < remote);
  assert.ok(remote < notes && notes < draft && draft < upload && upload < verifyDraft);
  assert.ok(verifyDraft < publish && publish < verifyPublic);
  assert.match(value.slice(draft, upload), /--draft/);
  assert.match(value.slice(publish), /--latest/);
  assert.equal(value.match(/\{name,size,digest\}/g)?.length, 2);
});
