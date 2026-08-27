#!/usr/bin/env bash

# Store the dedicated APT archive private key in the two protected GitHub
# environments used by Mirafold's manual and automated release workflows.
# The private key is streamed directly from GnuPG to GitHub CLI, which encrypts
# it locally; this script never prints it or writes an exported copy to disk.

set -Eeuo pipefail
umask 077

readonly REPOSITORY="mirafold/mirafold-desktop"
readonly SECRET_NAME="MIRAFOLD_APT_SIGNING_PRIVATE_KEY"
readonly KEY_IDENTITY="Mirafold APT Archive Signing <security@mirafold.com>"
readonly KEY_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/mirafold-apt-signing-v1"
readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd -P)"
readonly PUBLIC_KEY="${REPOSITORY_ROOT}/packaging/apt/mirafold-archive-keyring.gpg"
readonly FINGERPRINT_FILE="${REPOSITORY_ROOT}/packaging/apt/fingerprint.txt"
readonly ENVIRONMENTS=("manual-release" "automated-release")

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

trap 'printf "ERROR: GitHub secret setup stopped at script line %s. Re-running is safe.\n" "$LINENO" >&2' ERR

check_only=false
if (( $# == 1 )) && [[ $1 == "--check" ]]; then
  check_only=true
elif (( $# != 0 )); then
  fail "Usage: scripts/configure-github-apt-secret.sh [--check]"
fi

if [[ ${EUID} -eq 0 ]]; then
  fail "Do not run this script with sudo. The private key belongs to your normal user account."
fi

for command in awk gh gpg; do
  command -v "${command}" >/dev/null 2>&1 || fail "${command} is not installed."
done
[[ -f "${PUBLIC_KEY}" ]] || fail "The committed APT public key is missing."
[[ -f "${FINGERPRINT_FILE}" ]] || fail "The committed APT fingerprint is missing."

fingerprint="$(<"${FINGERPRINT_FILE}")"
[[ "${fingerprint}" =~ ^[A-F0-9]{40}$ ]] \
  || fail "The committed fingerprint is not one canonical 40-character fingerprint."

printf '[1/4] Verifying the local private key against the committed public identity\n'
mapfile -t secret_fingerprints < <(
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
)
(( ${#secret_fingerprints[@]} == 1 )) \
  || fail "The dedicated GnuPG directory does not contain exactly one matching private key."
[[ "${secret_fingerprints[0]}" == "${fingerprint}" ]] \
  || fail "The private key fingerprint differs from packaging/apt/fingerprint.txt."

public_fingerprint="$(
  gpg \
    --batch \
    --no-options \
    --homedir "${KEY_HOME}" \
    --with-colons \
    --import-options show-only \
    --import "${PUBLIC_KEY}" 2>/dev/null \
    | awk -F: '$1 == "fpr" { print $10; exit }'
)"
[[ "${public_fingerprint}" == "${fingerprint}" ]] \
  || fail "The committed public key differs from packaging/apt/fingerprint.txt."

printf '[2/4] Verifying GitHub authentication and protected environments\n'
gh auth status --hostname github.com >/dev/null
for environment in "${ENVIRONMENTS[@]}"; do
  observed="$(
    gh api \
      "repos/${REPOSITORY}/environments/${environment}" \
      --jq .name
  )"
  [[ "${observed}" == "${environment}" ]] \
    || fail "GitHub environment ${environment} was not found."
done

if [[ "${check_only}" == true ]]; then
  printf '[3/4] Check-only mode: no secret was changed\n'
  printf '[4/4] READY: local key, public identity, GitHub login, and both environments match.\n'
  exit 0
fi

printf '[3/4] Encrypting and storing the private key in both GitHub environments\n'
for environment in "${ENVIRONMENTS[@]}"; do
  gpg \
    --batch \
    --no-options \
    --homedir "${KEY_HOME}" \
    --armor \
    --export-secret-keys "${fingerprint}" \
    | gh secret set "${SECRET_NAME}" \
        --env "${environment}" \
        --repo "${REPOSITORY}"
done

printf '[4/4] Verifying both environment secret names without reading their values\n'
for environment in "${ENVIRONMENTS[@]}"; do
  count="$(
    gh secret list \
      --env "${environment}" \
      --repo "${REPOSITORY}" \
      --json name \
      --jq "map(select(.name == \"${SECRET_NAME}\")) | length"
  )"
  [[ "${count}" == "1" ]] \
    || fail "GitHub did not report ${SECRET_NAME} in ${environment}."
done

printf '\nSUCCESS: the APT signing key is stored in manual-release and automated-release.\n'
printf 'No private-key export was printed or written to disk.\n'
