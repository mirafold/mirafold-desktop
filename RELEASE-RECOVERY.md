# Release identity and recovery

This document is the recovery contract for Mirafold Desktop's Linux and
Windows release path. It distinguishes repository identity, build provenance,
operating-system signing, and account recovery because none substitutes for
the others.

## What identifies a release

Every release candidate contains 17 files: the existing five Linux and four
Windows payload/metadata/manifest files plus eight signed APT repository files.
`scripts/release-contract.mjs` verifies the exact filenames, updater SHA-512
values and sizes, block maps, and both platform manifests. The separate
standard-library APT verifier checks the committed archive fingerprint, both
OpenPGP signatures, Release/index/package hashes, and bootstrap-package
contents before attestation and again before publication. Changing any payload
after metadata generation makes publication fail.

After both native build jobs finish, a read-only dependency-free job signs the
APT metadata with the dedicated archive key. A separate GitHub Actions job then
verifies the merged 17-file set and asks GitHub to create SLSA build provenance
for all 17 digests. The provenance job receives a short-lived OpenID Connect
identity and attestation permission. It has no repository-write permission and
no archive private key. GitHub and Sigstore therefore provide the provenance
identity; there is no long-lived provenance key for Kyle to buy, download, back
up, or rotate. The APT archive key is a separate identity with its own backup
and rotation duties documented in `docs/RELEASING.md`.

This does **not** make the direct-download installers operating-system signed.
The Windows NSIS installer and Linux executables remain without embedded code
signatures. APT authenticates its repository metadata and `.deb` hash instead.
Windows
SmartScreen can consequently show an unrecognized-publisher warning. No
Windows code-signing certificate or private signing key currently exists. A
Microsoft Store package and its free Store-managed signing identity belong to
Phase 6; no Store developer account has been created or claimed here.

The updater's SHA-512 metadata, the downloadable SHA-256 manifests, and GitHub
provenance prove byte integrity and build origin. They do not make an unsigned
installer display a verified Windows publisher.

## Accounts and material Kyle must retain

The automated Desktop repository has no npm publication token. Its one
long-lived release secret is the dedicated APT archive private key, duplicated
across the two protected release environments and backed up outside the working
machine; losing it before an overlapping rotation breaks automatic trust for
existing APT clients. npm ownership and recovery belong to the upstream
`mirafold/mirafold` Shell release process. Desktop consumes the public package
only after npm signature, provenance, source-repository, source-tag, source-
commit, workflow-path, and builder checks pass.

`scripts/backup-apt-signing-key.sh` creates the recovery file by piping the
private export directly into GnuPG symmetric encryption, decrypts it only into
a verification pipe, and installs the encrypted result outside the repository
with owner-only permissions. Its passphrase must be retained separately and
the encrypted file must be copied off the working machine before the private
key is uploaded to GitHub. `scripts/configure-github-apt-secret.sh` then streams
the private export to GitHub without printing it or writing an unencrypted
copy.

GitHub account recovery is the human root of trust. Before automated
publication is enabled, Kyle should verify these privately in his own GitHub
account settings:

- At least two independent passkeys or hardware security keys are registered.
- Current GitHub recovery codes are stored offline in a place available if the
  normal computer and password manager are both unavailable.
- The account has a current, verified recovery email address.
- Security-alert notifications reach an account Kyle still monitors.

Recovery codes, passkey material, email access codes, npm tokens, and future
Store credentials must never be pasted into an issue, repository file, CI log,
or chat. Their presence cannot be verified from this repository, so this
document does not claim that those account preparations are complete.

Because the repository is public, source and published tags can be cloned by
anyone. That provides a source backup, not control of the established GitHub
publisher identity. Losing every GitHub recovery method can still prevent
publication from `mirafold/mirafold-desktop` even when the source is intact.

## Normal release boundaries

The workflow-level default token is read-only. Dependency installation, tests,
native packaging, manifest generation, and packaged smoke checks run without a
repository-write token. The APT signer receives the archive key but only a
read-only token and installs no dependencies. The provenance job alone receives
short-lived OpenID Connect and attestation permissions. The final writer alone
receives `contents: write`, installs no dependencies, and re-verifies the exact
release candidate and archive signature.

The live `automated-release` environment accepts only `main` and has no
reviewer, so a main-only nonpublishing rehearsal and routine verified Shell
releases require no human approval. The live `manual-release` environment
accepts only `v*` tags and requires Kyle as reviewer; self-review remains
allowed because this is a one-maintainer repository. These policies were
confirmed through GitHub's read-only API on 2026-08-26.
`.github/repository-hardening.json` remains the exact desired remote state the
reconciler audits.

The `main-release-safety` ruleset requires a pull request, successful
`test (linux)` and `test (windows)` checks from the GitHub Actions App and the
`DCO` sign-off check from the DCO App (ID `1861`), an up-to-date branch,
resolved review threads, linear history, and a squash or rebase merge. It
requires zero approvals so Kyle is not locked out of his solo repository. Only
GitHub Actions App ID `15368` has an always bypass, which preserves the audited
automated writer's atomic direct push of the Desktop version commit and tag;
that commit is itself signed off as `github-actions[bot]`. Dependabot does not
receive that bypass; its pull requests merge after the same three checks
(Dependabot signs its commits off). Force pushes and deletion remain blocked
for non-bypass actors.

The `next-staging-safety` ruleset protects the staging branch the same way —
pull request, the same three checks, linear history, no force-push or
deletion — with two differences: nothing may bypass it, and it does not
require the branch to be up to date, so day-to-day merges never queue behind
one another. `docs/RELEASING.md` describes how work flows `next` → `main`.

Required commit signatures are deliberately not enabled. The automated writer
currently creates an unsigned commit and annotated tag, and imposing a signing
key would add a new long-lived secret and a recovery burden. Artifact
provenance covers the downloadable build outputs instead.

## Partial or failed publication

The safe retry unit is the same GitHub Actions workflow run. Its immutable
intake, native, and signed APT artifacts are retained for seven days.

- Before the atomic branch/tag push succeeds, the public repository and release
  feed are unchanged.
- If the exact reviewed commit and annotated tag exist but no release exists,
  rerunning the failed jobs in the same run resumes with the original bytes.
- An incomplete or mismatched draft is replaced only after the coordinator
  proves the expected commit, tag, notes, asset sizes, and GitHub-calculated
  SHA-256 digests. A complete
  matching draft is published without rebuilding it.
- A complete matching public release that is already `latest` is an idempotent
  success.
- A stale `main`, conflicting tag, different commit, prerelease, mismatched
  notes, unexpected asset, or incomplete public release fails closed. Do not
  delete or overwrite that evidence to make the run green; diagnose the remote
  state first.
- After seven-day workflow-artifact expiry, do not reconstruct a missing asset
  under an existing tag. Cut a new higher Desktop version through the normal
  reviewed flow.

The updater is forward-only. Recovery from a bad Desktop release uses a new,
higher Desktop version carrying the restored implementation; installed clients
are never asked to downgrade.

## Repository-policy recovery

`scripts/repository-hardening.mjs validate` proves the local policy and its
merge/release compatibility without contacting GitHub. `audit` is read-only.
`apply` is an administrative mutation and requires the literal confirmation
`mirafold/mirafold-desktop`; it refuses to activate the ruleset until the two
required checks have both succeeded on remote `main`. It applies the ruleset
last, refuses to delete an unowned environment ref policy, and audits the final
state.

If a GitHub API failure interrupts application, rerun the audit before doing
anything else. The mutations are idempotent; a later approved apply can finish
the named policy. Do not delete unrelated rulesets or environments. The
reconciler refuses to compound another active repository ruleset or silently
remove an unknown deployment ref.

If the named ruleset itself unexpectedly prevents both Kyle's checked pull
request and the audited release writer, preserve the failing run URL and GitHub
rule-insight evidence first. Kyle may then disable only
`main-release-safety` from repository administration, repair the policy in a
reviewed branch, and restore it with the reconciler after both CI checks pass.
Disabling the ruleset is a break-glass administrative action, not a routine
release step.

Removing or changing the repository variable
`MIRAFOLD_AUTOMATED_RELEASES` cannot publish a release. When it is absent or not
exactly `enabled`, the write-capable automated job is skipped; intake, tests,
and a manual rehearsal may still run. Leave it absent until the non-publishing
17-file rehearsal, first signed APT release, and repository hardening have all
been accepted.

## Exact external state boundary

As observed through read-only GitHub APIs on 2026-08-13, the public repository
had read-only default Actions tokens, Dependabot vulnerability alerts enabled,
no repository ruleset, and no environments. Dependabot security updates,
private vulnerability reporting, repository secret scanning, and repository
push protection were disabled. No external setting was changed while preparing
this policy.

The desired settings live in `.github/repository-hardening.json`; the guarded
standard-library reconciler lives in `scripts/repository-hardening.mjs`.
Dependabot's weekly npm and GitHub Actions review policy lives in
`.github/dependabot.yml`. Non-provider secret patterns and secret validity
checks are recorded as unavailable because GitHub currently limits them to
eligible organization-owned repositories with paid Secret Protection; they are
not silently omitted or represented as free features of this user-owned
repository.
