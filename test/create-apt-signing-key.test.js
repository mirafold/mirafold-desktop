import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const REQUIRED_TOOLS = ["awk", "bash", "gpg", "install"];
const FINGERPRINT = /^[A-F0-9]{40}$/;

function toolAvailable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true });
  return !result.error && result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

test("the APT key setup creates one private identity and exports only its public half", {
  skip: process.platform !== "linux" || REQUIRED_TOOLS.some((tool) => !toolAvailable(tool)),
  timeout: 60_000,
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-apt-key-script-"));
  try {
    const repository = path.join(root, "repository");
    const scripts = path.join(repository, "scripts");
    const xdgData = path.join(root, "xdg-data");
    const script = path.join(scripts, "create-apt-signing-key.sh");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(new URL("../scripts/create-apt-signing-key.sh", import.meta.url), script);
    chmodSync(script, 0o755);
    const env = { ...process.env, XDG_DATA_HOME: xdgData };

    const created = run("bash", [script], { cwd: repository, env });
    assert.match(created, /\[2\/4\] Generating one RSA-3072 signing key/);
    assert.match(created, /SUCCESS: Mirafold APT signing identity is ready/);

    const publicDirectory = path.join(repository, "packaging", "apt");
    const publicKey = path.join(publicDirectory, "mirafold-archive-keyring.gpg");
    const fingerprintFile = path.join(publicDirectory, "fingerprint.txt");
    const fingerprint = readFileSync(fingerprintFile, "utf8").trim();
    assert.match(fingerprint, FINGERPRINT);
    assert.ok(statSync(publicKey).size > 0);
    assert.equal(statSync(publicKey).mode & 0o777, 0o644);
    assert.equal(statSync(fingerprintFile).mode & 0o777, 0o644);
    assert.equal(existsSync(path.join(repository, "private-keys-v1.d")), false);

    const keyHome = path.join(xdgData, "mirafold-apt-signing-v1");
    const secretListing = run("gpg", [
      "--batch",
      "--no-options",
      "--homedir",
      keyHome,
      "--with-colons",
      "--fingerprint",
      "--list-secret-keys",
    ]);
    assert.equal(secretListing.split("\n").filter((line) => line.startsWith("sec:")).length, 1);
    assert.ok(secretListing.includes(`fpr:::::::::${fingerprint}:`));

    const reused = run("bash", [script], { cwd: repository, env });
    assert.match(reused, /\[2\/4\] Reusing the matching key already present/);
    assert.equal(readFileSync(fingerprintFile, "utf8").trim(), fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
