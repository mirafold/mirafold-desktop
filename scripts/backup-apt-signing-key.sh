#!/usr/bin/env bash

# Create one encrypted recovery copy of Mirafold's dedicated APT archive key.
# The unencrypted private export exists only inside a pipe between two GnuPG
# processes; it is never printed and is never written to disk.

set -Eeuo pipefail
umask 077

readonly KEY_IDENTITY="Mirafold APT Archive Signing <security@mirafold.com>"
readonly KEY_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/mirafold-apt-signing-v1"
readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd -P)"
readonly PUBLIC_KEY="${REPOSITORY_ROOT}/packaging/apt/mirafold-archive-keyring.gpg"
readonly FINGERPRINT_FILE="${REPOSITORY_ROOT}/packaging/apt/fingerprint.txt"

temporary_backup=""

cleanup() {
  if [[ -n "${temporary_backup}" && -f "${temporary_backup}" ]]; then
    rm -f -- "${temporary_backup}"
  fi
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

trap cleanup EXIT
trap 'printf "ERROR: encrypted backup stopped at script line %s. No completed backup was installed.\n" "$LINENO" >&2' ERR

if (( $# > 1 )); then
  fail "Usage: scripts/backup-apt-signing-key.sh [encrypted-output-file]"
fi
if [[ ${EUID} -eq 0 ]]; then
  fail "Do not run this script with sudo. The private key belongs to your normal user account."
fi

for command in awk basename chmod dirname gpg mktemp mv sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || fail "${command} is not installed."
done
[[ -d "${KEY_HOME}" ]] || fail "The dedicated GnuPG directory is missing: ${KEY_HOME}"
[[ -f "${PUBLIC_KEY}" ]] || fail "The committed APT public key is missing."
[[ -f "${FINGERPRINT_FILE}" ]] || fail "The committed APT fingerprint is missing."

requested_backup="${1:-${HOME}/mirafold-apt-signing-private-key-v1-backup.asc.gpg}"
backup_parent="$(cd -- "$(dirname -- "${requested_backup}")" && pwd -P)" \
  || fail "The backup destination directory does not exist."
backup_name="$(basename -- "${requested_backup}")"
[[ -n "${backup_name}" && "${backup_name}" != "." && "${backup_name}" != ".." ]] \
  || fail "The backup destination must name a file."
readonly BACKUP_FILE="${backup_parent}/${backup_name}"

case "${BACKUP_FILE}" in
  "${REPOSITORY_ROOT}"|"${REPOSITORY_ROOT}"/*)
    fail "The encrypted recovery copy must be stored outside the repository."
    ;;
esac
[[ ! -e "${BACKUP_FILE}" && ! -L "${BACKUP_FILE}" ]] \
  || fail "Refusing to overwrite the existing backup: ${BACKUP_FILE}"

fingerprint="$(<"${FINGERPRINT_FILE}")"
[[ "${fingerprint}" =~ ^[A-F0-9]{40}$ ]] \
  || fail "The committed fingerprint is not one canonical 40-character fingerprint."

printf '[1/4] Verifying the local private key and committed public identity\n'
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

printf '[2/4] Creating an encrypted recovery copy outside the repository\n'
printf 'GnuPG will ask you to create and confirm a backup passphrase.\n'
temporary_backup="$(mktemp "${backup_parent}/.${backup_name}.partial.XXXXXX")"
if ! gpg \
    --batch \
    --no-options \
    --homedir "${KEY_HOME}" \
    --armor \
    --export-secret-keys "${fingerprint}" \
  | gpg \
      --no-options \
      --homedir "${KEY_HOME}" \
      --yes \
      --armor \
      --symmetric \
      --cipher-algo AES256 \
      --output "${temporary_backup}"; then
  fail "GnuPG did not create the encrypted recovery copy."
fi
[[ -s "${temporary_backup}" ]] || fail "The encrypted recovery copy is empty."

printf '[3/4] Decrypting through a pipe to verify the saved identity\n'
verification="$({
  gpg \
    --no-options \
    --homedir "${KEY_HOME}" \
    --quiet \
    --decrypt "${temporary_backup}" \
  | gpg \
      --batch \
      --no-options \
      --homedir "${KEY_HOME}" \
      --with-colons \
      --import-options show-only \
      --import 2>/dev/null
})" || fail "The encrypted recovery copy could not be decrypted and inspected."

mapfile -t recovered_fingerprints < <(
  printf '%s\n' "${verification}" \
    | awk -F: '
        $1 == "sec" { primary = 1; next }
        primary == 1 && $1 == "fpr" { print $10; primary = 0 }
      '
)
(( ${#recovered_fingerprints[@]} == 1 )) \
  || fail "The recovery copy does not contain exactly one primary private-key identity."
[[ "${recovered_fingerprints[0]}" == "${fingerprint}" ]] \
  || fail "The recovery copy contains a different private-key identity."

printf '[4/4] Installing the verified encrypted file with owner-only permissions\n'
chmod 0600 -- "${temporary_backup}"
mv -- "${temporary_backup}" "${BACKUP_FILE}"
temporary_backup=""

printf '\nSUCCESS: encrypted APT signing-key recovery copy created.\n'
printf 'File: %s\n' "${BACKUP_FILE}"
printf 'SHA-256: '
sha256sum -- "${BACKUP_FILE}" | awk '{print $1}'
printf 'The unencrypted private key was never printed or written to disk.\n'
printf 'Keep the passphrase separate, then copy this encrypted file off this machine.\n'
