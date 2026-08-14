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
const releaseContract = readFileSync(new URL("../scripts/release-contract.mjs", import.meta.url), "utf8");

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

test("the build job verifies every updater asset before retaining it", () => {
  const build = job("build");
  assert.match(build, /packaged-smoke\.mjs "\$\{\{ matrix\.name \}\}" dist/);
  assert.match(build, /if: matrix\.name == 'windows'\s*\n\s+run: node scripts\/windows-installer-smoke\.mjs dist/);
  const packaged = build.indexOf("packaged-smoke.mjs");
  const installed = build.indexOf("windows-installer-smoke.mjs");
  const manifest = build.indexOf("release-contract.mjs manifest");
  const contract = build.indexOf("release-contract.mjs platform");
  assert.ok(
    packaged !== -1 && packaged < installed && installed < manifest,
    "packaged and installed Windows runtime proofs must precede retained artifacts",
  );
  assert.ok(manifest !== -1 && manifest < contract, "SHA-256 manifest must precede final verification");
  assert.match(build, /release-contract\.mjs platform "\$\{\{ matrix\.name \}\}" dist/);
  assert.match(build, /node node_modules\/electron-builder\/cli\.js \$\{\{ matrix\.args \}\}/);
  assert.doesNotMatch(build, /\bnpx\b/);
  for (const pattern of [
    "dist/SHA256SUMS-*.txt",
    "dist/latest*.yml",
    "dist/*.blockmap",
    "dist/*.deb",
    "dist/*.tar.gz",
    "dist/*.AppImage",
    "dist/*.exe",
  ]) {
    assert.ok(build.includes(pattern), `artifact upload omits ${pattern}`);
  }
  assert.match(build, /if-no-files-found: error/);
});

// Pins the 2026-08-14 audit finding: the build job was the only dependency
// install in the repository that still ran lifecycle scripts, so ~400 packages'
// install scripts could execute on the manual-release path and shape the exact
// bytes published to users — a surface the CI and Shell-intake installs had
// already closed with `--ignore-scripts` and the pinned npm toolchain.
test("the build job installs with the script-free pinned npm toolchain", () => {
  const build = job("build");
  assert.match(build, /NPM_CONFIG_IGNORE_SCRIPTS: "true"/);
  assert.match(build, /NPM_CONFIG_USERCONFIG: \$\{\{ runner\.temp \}\}\/mirafold-empty-npmrc/);
  assert.match(build, /NPM_CONFIG_REGISTRY: https:\/\/registry\.npmjs\.org/);
  assert.match(build, /test "\$\(npm --version\)" = "12\.0\.2"/);
  assert.doesNotMatch(build, /cache:/);
  const installTool = build.indexOf("npm install --global npm@12.0.2");
  const installTree = build.indexOf("npm ci --ignore-scripts");
  const list = build.indexOf("npm ls --all");
  const audit = build.indexOf("npm audit --audit-level=moderate");
  const signatures = build.indexOf("npm audit signatures --include-attestations");
  const tests = build.indexOf("npm test");
  assert.ok(installTool !== -1 && installTool < installTree, "the pinned toolchain must precede npm ci");
  assert.ok(installTree < list && list < audit && audit < signatures && signatures < tests,
    "install, tree, audit, signature, and test order changed");
  assert.doesNotMatch(build, /run: npm ci\s*$/m, "no unhardened npm ci may remain");
});

test("tag identity and stable-channel policy are checked before dependency code", () => {
  const build = job("build");
  const identity = build.indexOf("release-contract.mjs identity");
  const install = build.indexOf("npm ci");
  assert.ok(identity !== -1 && install !== -1 && identity < install);
});

test("only the release job may write repository contents", () => {
  const release = job("release");
  assert.match(release, /permissions:\s*\n\s+contents: write/);
  assert.match(release, /needs: \[build, attest\]/);
  assert.match(release, /environment: manual-release/);
  assert.match(release, /concurrency:\s*\n\s+group: mirafold-desktop-publication\s*\n\s+cancel-in-progress: false/);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
});

test("a manual release rehearsal cannot enter the publishing job", () => {
  const header = workflow.slice(0, workflow.indexOf("\njobs:"));
  const release = job("release");
  assert.match(header, /workflow_dispatch:/);
  assert.match(
    header,
    /fail_platform:\s*\n\s+description: .+\n\s+required: true\s*\n\s+default: none\s*\n\s+type: choice\s*\n\s+options:\s*\n\s+- none\s*\n\s+- linux\s*\n\s+- windows/,
  );
  assert.match(release, /if: github\.event_name == 'push'/);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
  for (const name of ["build", "attest"]) {
    const value = job(name);
    assert.doesNotMatch(value, /\bgh release\b/);
    assert.doesNotMatch(value, /\bgit push\b/);
  }
});

for (const platform of ["linux", "windows"]) {
  test(`a manual ${platform} failure rehearsal stops before dependency code`, () => {
    const build = job("build");
    const injection = build.indexOf("name: Inject requested rehearsal failure");
    const install = build.indexOf("npm ci --ignore-scripts");
    assert.ok(injection !== -1 && injection < install);
    assert.match(
      build.slice(injection, install),
      /github\.event_name == 'workflow_dispatch' &&\s*\n\s+inputs\.fail_platform == matrix\.name/,
    );
  });
}

test("provenance receives OIDC only after both native builds and cannot publish", () => {
  const attest = job("attest");
  assert.match(attest, /needs: build/);
  assert.match(attest, /contents: read/);
  assert.match(attest, /id-token: write/);
  assert.match(attest, /attestations: write/);
  assert.match(attest, /artifact-metadata: write/);
  assert.doesNotMatch(attest, /contents: write/);
  assert.match(attest, /persist-credentials: false/);
  const download = attest.indexOf("uses: actions/download-artifact@");
  const verify = attest.indexOf("release-contract.mjs artifacts");
  const provenance = attest.indexOf("uses: actions/attest@");
  assert.ok(download !== -1 && download < verify && verify < provenance);
  assert.match(attest, /subject-path: \$\{\{ runner\.temp \}\}\/mirafold-release-assets\/\*/);
  assert.doesNotMatch(attest, /\bnpm\s+(?:ci|install|test|run)\b/);
  assert.doesNotMatch(attest, /\bnpx\b/);
});

test("the write-capable release job runs no installed dependency code", () => {
  const release = job("release");
  const executableLines = release
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(release, /persist-credentials: false/);
  assert.doesNotMatch(executableLines, /\bnpm\s+(?:ci|install)\b/);
  assert.doesNotMatch(executableLines, /\bnpx\b/);
});

test("the release verifier keeps dependency code out of its static writer path", () => {
  const imports = [...releaseContract.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(imports.length > 0, "release verifier import scan found nothing");
  assert.deepEqual(
    imports.filter((specifier) => !specifier.startsWith("node:")),
    [],
    "write-capable release verification must not load dependency code",
  );
  assert.match(
    releaseContract,
    /await import\(["']@noble\/hashes\/blake2\.js["']\)/,
    "blockmap hashing must remain an explicit lazy import in read-only platform verification",
  );
});

test("a release stays draft until its complete remote asset set is verified", () => {
  const release = job("release");
  const complete = release.indexOf("release-contract.mjs complete");
  const create = release.indexOf('gh release create "$RELEASE_TAG"');
  const upload = release.indexOf('gh release upload "$RELEASE_TAG"');
  const remote = release.indexOf('draft "$RELEASE_TAG" artifacts');
  const publish = release.indexOf('gh release edit "$RELEASE_TAG"');
  const published = release.indexOf("release-contract.mjs published");
  assert.ok(complete !== -1 && complete < create, "local complete-set verification must precede draft creation");
  assert.ok(create < upload && upload < remote && remote < publish, "draft upload/verification/publication order changed");
  assert.match(release.slice(create, upload), /--draft/);
  assert.match(release.slice(publish), /--draft=false/);
  assert.match(release.slice(publish), /--prerelease=false/);
  assert.match(release.slice(publish), /--latest/);
  assert.ok(publish < published, "public/latest verification must follow publication");
  assert.equal(release.match(/\{name,size,digest\}/g)?.length, 2, "draft and public assets must expose GitHub SHA-256 digests");
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
