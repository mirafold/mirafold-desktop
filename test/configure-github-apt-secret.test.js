import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const FINGERPRINT = "1234567890ABCDEF1234567890ABCDEF12345678";
const PRIVATE_FIXTURE = "PRIVATE-KEY-FIXTURE-NEVER-PERSIST";

function executable(file, contents) {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function run(script, args, options) {
  const result = spawnSync("bash", [script, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("GitHub APT secret setup checks safely and streams to exactly two environments", {
  skip: process.platform !== "linux",
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "mirafold-apt-secret-script-"));
  try {
    const repository = path.join(root, "repository");
    const scripts = path.join(repository, "scripts");
    const packaging = path.join(repository, "packaging", "apt");
    const commands = path.join(root, "commands");
    const data = path.join(root, "data");
    const log = path.join(root, "gh.log");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(packaging, { recursive: true });
    mkdirSync(commands);
    mkdirSync(path.join(data, "mirafold-apt-signing-v1"), { recursive: true });
    const script = path.join(scripts, "configure-github-apt-secret.sh");
    copyFileSync(new URL("../scripts/configure-github-apt-secret.sh", import.meta.url), script);
    chmodSync(script, 0o755);
    writeFileSync(path.join(packaging, "fingerprint.txt"), `${FINGERPRINT}\n`);
    writeFileSync(path.join(packaging, "mirafold-archive-keyring.gpg"), "public fixture\n");

    executable(path.join(commands, "gpg"), `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" --list-secret-keys "*)
    printf 'sec:u:3072:1:fixture:0:0::::::sc::::::23:\\nfpr:::::::::${FINGERPRINT}:\\n'
    ;;
  *" --import-options show-only "*)
    printf 'pub:u:3072:1:fixture:0:0::::::sc::::::23:\\nfpr:::::::::${FINGERPRINT}:\\n'
    ;;
  *" --export-secret-keys "*)
    printf '%s' '${PRIVATE_FIXTURE}'
    ;;
  *)
    printf 'unexpected fake gpg invocation: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`);

    executable(path.join(commands, "gh"), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "auth status")
    printf 'auth\\n' >> "$GH_TEST_LOG"
    ;;
  "api repos/mirafold/mirafold-desktop/environments/manual-release")
    printf 'api manual-release\\n' >> "$GH_TEST_LOG"
    printf 'manual-release\\n'
    ;;
  "api repos/mirafold/mirafold-desktop/environments/automated-release")
    printf 'api automated-release\\n' >> "$GH_TEST_LOG"
    printf 'automated-release\\n'
    ;;
  "secret set")
    environment=''
    previous=''
    for argument in "$@"; do
      if [[ "$previous" == '--env' ]]; then environment="$argument"; fi
      previous="$argument"
    done
    payload="$(</dev/stdin)"
    [[ "$payload" == '${PRIVATE_FIXTURE}' ]]
    printf 'set %s %s\\n' "$environment" "\${#payload}" >> "$GH_TEST_LOG"
    ;;
  "secret list")
    printf 'list\\n' >> "$GH_TEST_LOG"
    printf '1\\n'
    ;;
  *)
    printf 'unexpected fake gh invocation: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`);

    writeFileSync(log, "");
    const env = {
      ...process.env,
      GH_TEST_LOG: log,
      PATH: `${commands}:${process.env.PATH}`,
      XDG_DATA_HOME: data,
    };
    const checked = run(script, ["--check"], { cwd: repository, env });
    assert.match(checked, /READY: local key, public identity, GitHub login, and both environments match/);
    assert.doesNotMatch(checked, /PRIVATE-KEY/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /^set /m);

    writeFileSync(log, "");
    const configured = run(script, [], { cwd: repository, env });
    assert.match(configured, /SUCCESS: the APT signing key is stored/);
    assert.doesNotMatch(configured, /PRIVATE-KEY/);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "auth",
      "api manual-release",
      "api automated-release",
      `set manual-release ${PRIVATE_FIXTURE.length}`,
      `set automated-release ${PRIVATE_FIXTURE.length}`,
      "list",
      "list",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
