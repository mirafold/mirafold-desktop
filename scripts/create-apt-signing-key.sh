#!/usr/bin/env bash

# Create Mirafold's first dedicated APT archive-signing identity.
#
# The private key stays in a GnuPG home outside the repository. Only the public
# key and its fingerprint are exported into packaging/apt for review and use by
# the release verifier. Re-running the script reuses the one matching key and
# refuses ambiguous or conflicting state rather than creating another identity.

set -Eeuo pipefail
umask 077

readonly KEY_IDENTITY="Mirafold APT Archive Signing <security@mirafold.com>"
readonly KEY_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/mirafold-apt-signing-v1"
readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd -P)"
readonly PUBLIC_DIRECTORY="${REPOSITORY_ROOT}/packaging/apt"
readonly PUBLIC_KEY="${PUBLIC_DIRECTORY}/mirafold-archive-keyring.gpg"
readonly FINGERPRINT_FILE="${PUBLIC_DIRECTORY}/fingerprint.txt"

temporary_key=""
temporary_fingerprint=""

cleanup() {
  if [[ -n "${temporary_key}" && -f "${temporary_key}" ]]; then
    rm -f -- "${temporary_key}"
  fi
  if [[ -n "${temporary_fingerprint}" && -f "${temporary_fingerprint}" ]]; then
    rm -f -- "${temporary_fingerprint}"
  fi
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

trap cleanup EXIT
trap 'printf "ERROR: key setup stopped at script line %s.\n" "$LINENO" >&2' ERR

if [[ ${EUID} -eq 0 ]]; then
  fail "Do not run this script with sudo. The private key must belong to your normal user account."
fi

command -v gpg >/dev/null 2>&1 || fail "gpg is not installed."
command -v awk >/dev/null 2>&1 || fail "awk is not installed."
command -v install >/dev/null 2>&1 || fail "install from GNU coreutils is not available."

printf '[1/4] Preparing the private GnuPG directory\n'
install -d -m 0700 -- "${KEY_HOME}"
chmod 0700 -- "${KEY_HOME}"

primary_fingerprints() {
  gpg \
    --batch \
    --no-options \
    --homedir "${KEY_HOME}" \
    --with-colons \
    --fingerprint \
    --list-secret-keys "${KEY_IDENTITY}" 2>/dev/null \
    | awk -F: '
        $1 == "sec" { primary = 1; next }
        primary == 1 && $1 == "fpr" { print $10; primary = 0 }
      '
}

mapfile -t fingerprints < <(primary_fingerprints)
if (( ${#fingerprints[@]} > 1 )); then
  fail "More than one matching private key exists in ${KEY_HOME}; refusing to choose one."
fi

if (( ${#fingerprints[@]} == 0 )); then
  printf '[2/4] Generating one RSA-3072 signing key; this can take several seconds\n'
  gpg \
    --batch \
    --no-options \
    --homedir "${KEY_HOME}" \
    --pinentry-mode loopback \
    --passphrase '' \
    --quick-generate-key "${KEY_IDENTITY}" rsa3072 sign 3y
  mapfile -t fingerprints < <(primary_fingerprints)
else
  printf '[2/4] Reusing the matching key already present\n'
fi

if (( ${#fingerprints[@]} != 1 )); then
  fail "GnuPG did not produce exactly one matching private key."
fi

readonly fingerprint="${fingerprints[0]}"
[[ "${fingerprint}" =~ ^[A-F0-9]{40}$ ]] \
  || fail "GnuPG returned a non-canonical fingerprint."

printf '[3/4] Exporting only the public key into the repository\n'
install -d -m 0755 -- "${PUBLIC_DIRECTORY}"
temporary_key="$(mktemp "${PUBLIC_DIRECTORY}/.mirafold-public-key.XXXXXX")"
temporary_fingerprint="$(mktemp "${PUBLIC_DIRECTORY}/.mirafold-fingerprint.XXXXXX")"
gpg \
  --batch \
  --no-options \
  --homedir "${KEY_HOME}" \
  --export "${fingerprint}" > "${temporary_key}"
[[ -s "${temporary_key}" ]] || fail "The exported public key is empty."
printf '%s\n' "${fingerprint}" > "${temporary_fingerprint}"

if [[ -e "${PUBLIC_KEY}" ]] && ! cmp -s -- "${temporary_key}" "${PUBLIC_KEY}"; then
  fail "${PUBLIC_KEY} already contains a different public key."
fi
if [[ -e "${FINGERPRINT_FILE}" ]] && ! cmp -s -- "${temporary_fingerprint}" "${FINGERPRINT_FILE}"; then
  fail "${FINGERPRINT_FILE} already contains a different fingerprint."
fi

install -m 0644 -- "${temporary_key}" "${PUBLIC_KEY}"
install -m 0644 -- "${temporary_fingerprint}" "${FINGERPRINT_FILE}"

printf '[4/4] Verifying the exported public identity\n'
exported_fingerprint="$(
  gpg \
    --batch \
    --no-options \
    --homedir "${KEY_HOME}" \
    --with-colons \
    --import-options show-only \
    --import "${PUBLIC_KEY}" 2>/dev/null \
    | awk -F: '$1 == "fpr" { print $10; exit }'
)"
[[ "${exported_fingerprint}" == "${fingerprint}" ]] \
  || fail "The exported public key fingerprint does not match the private key."

printf '\nSUCCESS: Mirafold APT signing identity is ready.\n'
printf 'Public fingerprint: %s\n' "${fingerprint}"
printf 'Private key directory: %s\n' "${KEY_HOME}"
printf 'Public key file: %s\n' "${PUBLIC_KEY}"
printf 'Fingerprint file: %s\n' "${FINGERPRINT_FILE}"
printf 'The private key was not exported or written into the repository.\n'
