import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../scripts/backup-apt-signing-key.sh", import.meta.url);
const fingerprint = readFileSync(
  new URL("../packaging/apt/fingerprint.txt", import.meta.url),
  "utf8",
).trim();
const fakePrivateMaterial = "FAKE PRIVATE KEY MATERIAL FOR TESTS ONLY\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mirafold-apt-backup-test-"));
  const home = join(root, "home");
  const dataHome = join(root, "data");
  const keyHome = join(dataHome, "mirafold-apt-signing-v1");
  const fakeBin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(keyHome, { recursive: true });
  mkdirSync(fakeBin);

  const fakeGpg = join(fakeBin, "gpg");
  writeFileSync(
    fakeGpg,
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >> "$FAKE_GPG_LOG"

if [[ " $* " == *" --list-secret-keys "* ]]; then
  printf 'sec:-:3072:1:AD4514FE0C3F6F0C:1787802771:1882410771:::::scSC::::::23::0:\\n'
  printf 'fpr:::::::::${fingerprint}:\\n'
elif [[ " $* " == *" --export-secret-keys "* ]]; then
  printf '${fakePrivateMaterial.replaceAll("\n", "\\n")}'
elif [[ " $* " == *" --symmetric "* ]]; then
  input="$(cat)"
  [[ "$input" == '${fakePrivateMaterial.trim()}' ]]
  [[ " $* " == *" --yes "* ]]
  output=''
  while (( $# > 0 )); do
    if [[ $1 == '--output' ]]; then
      output=$2
      break
    fi
    shift
  done
  [[ -n "$output" ]]
  [[ -f "$output" ]]
  printf 'ENCRYPTED TEST FIXTURE\\n' > "$output"
  if [[ "\${FAKE_GPG_FAIL_ENCRYPT:-false}" == true ]]; then
    exit 17
  fi
elif [[ " $* " == *" --decrypt "* ]]; then
  printf '${fakePrivateMaterial.replaceAll("\n", "\\n")}'
elif [[ " $* " == *" --import-options show-only "* ]]; then
  if [[ "\${*: -1}" == '--import' ]]; then
    input="$(cat)"
    [[ "$input" == '${fakePrivateMaterial.trim()}' ]]
    printf 'sec:-:3072:1:AD4514FE0C3F6F0C:1787802771:1882410771:::::scSC::::::23::0:\\n'
  else
    printf 'pub:-:3072:1:AD4514FE0C3F6F0C:1787802771:1882410771:::::scSC::::::23::0:\\n'
  fi
  printf 'fpr:::::::::${fingerprint}:\\n'
else
  printf 'unexpected fake gpg call: %s\\n' "$*" >&2
  exit 99
fi
`,
  );
  chmodSync(fakeGpg, 0o755);

  const log = join(root, "gpg-calls.log");
  return {
    root,
    home,
    dataHome,
    log,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
      FAKE_GPG_LOG: log,
    },
  };
}

test("the backup helper encrypts and verifies without persisting plaintext", {
  skip: process.platform !== "linux",
}, () => {
  const setup = fixture();
  try {
    const destination = join(setup.home, "mirafold-apt-signing-private-key-v1-backup.asc.gpg");
    const result = spawnSync("bash", [script.pathname], {
      cwd: setup.home,
      env: setup.env,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SUCCESS: encrypted APT signing-key recovery copy created/);
    assert.doesNotMatch(result.stdout + result.stderr, /FAKE PRIVATE KEY MATERIAL/);
    assert.equal(readFileSync(destination, "utf8"), "ENCRYPTED TEST FIXTURE\n");
    assert.equal(statSync(destination).mode & 0o777, 0o600);

    const files = readdirSync(setup.home);
    assert.deepEqual(files, ["mirafold-apt-signing-private-key-v1-backup.asc.gpg"]);

    const callsBeforeRefusal = readFileSync(setup.log, "utf8");
    const refusal = spawnSync("bash", [script.pathname], {
      cwd: setup.home,
      env: setup.env,
      encoding: "utf8",
    });
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, /Refusing to overwrite the existing backup/);
    assert.equal(readFileSync(setup.log, "utf8"), callsBeforeRefusal);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("a failed encryption leaves neither a destination nor a partial file", {
  skip: process.platform !== "linux",
}, () => {
  const setup = fixture();
  try {
    const destination = join(setup.home, "failed-backup.asc.gpg");
    const result = spawnSync("bash", [script.pathname, destination], {
      cwd: setup.home,
      env: { ...setup.env, FAKE_GPG_FAIL_ENCRYPT: "true" },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GnuPG did not create the encrypted recovery copy/);
    assert.deepEqual(readdirSync(setup.home), []);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});
