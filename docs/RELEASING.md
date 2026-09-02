# Releasing Mirafold Desktop — branches, versions, tags

Adopted 2026-08-17, ahead of the first public Desktop launch. It is the same
flow the `mirafold` Shell repository uses, with one addition this repository
needs: most Desktop releases are cut by automation, not by a person. One
principle generates every rule here:

> **`main` is the production mirror: it advances only at release time, so the
> code on `main` and the installers people download are always the same
> thing.**

"Production" is the GitHub Releases feed — the 17 files per version consumed
by the direct updater and the APT channel (`README.md` → *How updates work*).
`main` is protected so that it can move in exactly two ways, and both are
releases.

## The branches

| branch | what it is | protection (GitHub rulesets, `.github/repository-hardening.json`) |
| --- | --- | --- |
| `main` | the production mirror — every commit on it is inside some release | pull-request-only, `test (linux)` + `test (windows)` + `DCO` required, branch must be up to date, linear history, no force-push/delete. **One bypass:** the GitHub Actions App, so the audited automated release writer can push its version commit + tag directly. |
| `next` | staging — day-to-day work accumulates here | pull-request-only for everyone, same three required checks, linear history, no force-push/delete, **no bypass at all** |
| `feature/*`, `fix/*`, `refactor/*`, `docs/*` | working branches, cut from `next` | none — name them anything, force-push freely |
| `release/x.y.z` | short-lived Desktop release prep, cut from `next` (or from `main` for a hotfix) | none — it exists for hours |

Mechanics to know:

- **Every commit headed for a PR needs a DCO sign-off** — commit with
  `git commit -s`. The DCO check is required on both protected branches. A
  local `prepare-commit-msg` hook that appends the trailer automatically is
  in `CONTRIBUTING.md`; `git rebase --signoff` repairs a branch that missed
  it. The automated writer signs its own release commit off as
  `github-actions[bot]`.
- **An open or green PR is not approval to merge it.** Keep the PR open
  through review and follow-up work. When it appears ready, ask Kyle
  explicitly whether to merge; merge only after he approves.
- **A `v*` tag releases only `main`'s current tip.** The `Release` workflow's
  first step fails any tag pointing elsewhere; its second step fails a tag
  whose version differs from `package.json`. The tag trigger is branch-blind
  by platform design; the guards are what make a mis-aimed tag a red workflow
  run instead of a bad release.
- **Squash or rebase merges only, everywhere** (repository setting plus both
  rulesets). Content converges between `main` and `next`; commit hashes need
  not, and nothing here depends on them.
- **Versions.** Desktop and Shell are versioned independently; the Help menu
  shows both. Every Desktop release bumps the Desktop version — the updater
  is forward-only and refuses a lower or equal version. Automated Shell
  intake bumps the **patch**; a manual Desktop release bumps whatever the
  change warrants (a new capability is a minor bump).

## APT archive identity and secret boundary

The Ubuntu repository is the latest stable GitHub Release viewed as a signed
flat APT repository. Eight APT files accompany the nine existing native files:
`Packages`, `Packages.gz`, `Release`, `InRelease`, `Release.gpg`,
`mirafold-archive-keyring_1.0_all.deb`, `mirafold-archive-keyring.gpg`, and
`mirafold.sources`. Package filenames in the index are relative to that release
root. The source uses exact-path suite `./` and `Signed-By`, so this key grants
trust only to Mirafold's source.

The v1 archive identity is:

- fingerprint `30C663842E3433E94B793B79AD4514FE0C3F6F0C`;
- RSA-3072, signing-only use, expiring 2029-08-26;
- public material in `packaging/apt/`;
- private GnuPG home at
  `${XDG_DATA_HOME:-$HOME/.local/share}/mirafold-apt-signing-v1` on Kyle's
  machine; and
- GitHub environment secret `MIRAFOLD_APT_SIGNING_PRIVATE_KEY`, stored
  separately in `manual-release` and `automated-release`.

The private key deliberately has no passphrase because GitHub Actions must use
it unattended. Filesystem ownership, an encrypted recovery copy kept outside
the working machine, and the protected GitHub environments are therefore the
security boundary. Never commit, paste, log, or write an unencrypted export.
`scripts/create-apt-signing-key.sh` creates or reuses exactly one matching key
and exports only its public half. `scripts/backup-apt-signing-key.sh` streams
that private identity through GnuPG symmetric encryption, verifies the
encrypted result through a pipe, and writes only the encrypted recovery file
outside the repository. Keep its passphrase separately and copy the encrypted
file off the working machine before configuring GitHub.
`scripts/configure-github-apt-secret.sh --check` verifies local/GitHub identity
without mutation; running it without the flag streams the private export
directly to `gh secret set`, which encrypts it locally, and verifies only the
two resulting secret names.

Both release paths keep powers split. Native jobs run dependency code with a
read-only token and no archive key. A separate Ubuntu job receives the key but
only a read-only token, installs no dependencies, builds and verifies the APT
repository, erases its temporary GnuPG home, and uploads an immutable artifact.
The provenance job independently verifies the signature and attests all 17
files. The publisher independently verifies it again before receiving or using
repository write access. A nonpublishing rehearsal runs from canonical `main`
and obtains the signer from the main-only `automated-release` environment. A
real `v*` tag obtains the signer from `manual-release`; signing and publication
are then separate reviewer-protected deployments.

Key rotation is an overlapping release operation, never a same-day swap: bump
the archive-keyring package version, ship both old and new public keys while
`Release` is still signed by the old trusted key, wait for supported users to
receive that keyring update, then sign with the replacement. Losing the old
private key before overlap means existing users cannot authenticate the new
identity automatically.

## Path A — automated: a new Shell version becomes a Desktop release

This is the routine path and needs no person once it is enabled. The
`Shell intake` workflow (`.github/workflows/shell-intake.yml`) polls npm's
`mirafold` `latest` tag twice an hour. When it changes, the workflow proves the
package's npm provenance back to `mirafold/mirafold`'s release workflow, pins
the exact version, bumps the Desktop patch version, tests on both platforms,
builds and smoke-checks native Linux and Windows packages, signs the APT index,
attests provenance,
and then — in one isolated job that installs no dependencies — commits the
version bump, tags it, pushes commit and tag atomically to `main` (the ruleset
bypass), and publishes the verified 17-file GitHub Release. Retries resume;
nothing partial ever becomes visible.

It publishes only while the repository variable `MIRAFOLD_AUTOMATED_RELEASES`
is exactly `enabled`. It was kept dormant through the first signed APT release
(0.3.2) and its nonpublishing rehearsals (Path B, below), so routine
publication could not start before the new repository channel existed and had
been exercised; **the variable was set 2026-08-30 and Path A is live.** The
scheduler is best-effort (polls can land an hour or more apart), so a Shell
release that should not wait can be carried immediately with **Actions → Shell
intake → Run workflow** on `main` — the manual run publishes only because the
variable is set.

`README.md` → *Automated Shell releases* has the full contract;
`RELEASE-RECOVERY.md` has the failure and retry states.

## Path B — manual: a Desktop-only release

For changes to this repository itself (the shell, the updater, packaging), and
for the one-time bridge release.

1. **Feature work**: branch off `next`, commit with `-s`, open a PR into
   `next`. Keep follow-ups on that PR; ask Kyle for merge approval when it
   appears ready. Repeat until `next` holds the release you want.
2. **Reconstruct the exact reviewed staging tree on production's parent.** Make
   sure the previous release's `main` → `next` sync is complete first; if Path A
   has published since that sync, complete a new sync PR before continuing.
   Then start from current production and apply the direct tree difference:

   ```
   git fetch origin
   git switch -c release/x.y.z origin/main
   git diff --binary origin/main origin/next | git apply --index
   git diff --cached --quiet origin/next
   git diff --quiet
   ```

   Both final commands must exit zero. This is intentionally a two-tree
   reconstruction, not an ancestry merge: protected branches use squash merges,
   so equivalent prior content has different commit ancestry. A normal merge
   manufactured six conflicts during the `0.3.0` release even though direct
   tree comparison proved the only content difference was the reviewed feature.
3. **Write the release notes and bump the Desktop version.** Replace
   `.github/RELEASE_NOTES.md` with notes for this release, including these
   exact lines under `## Included versions`:

   ```text
   - Mirafold Desktop `x.y.z`
   - Mirafold Shell `x.y.z`
   ```

   Then bump the Desktop version in `package.json` and `package-lock.json`,
   stage the three release-specific files, verify the complete staged patch,
   and create one signed-off release commit:

   ```
   npm version x.y.z --no-git-tag-version
   git add .github/RELEASE_NOTES.md package.json package-lock.json
   git diff --cached --check
   git commit -s -m "release: vx.y.z"
   ```
4. **PR `release/x.y.z` → `main`**, merge on green.
5. **Rehearse the exact merged commit without publishing:** manually dispatch
   the `Release` workflow from `main` with `fail_platform=none`. The workflow
   requires canonical `main` before dependency code, builds and smoke-checks
   both native packages, signs the APT repository with the production key from
   the main-only `automated-release` environment, verifies all 17 files, and
   creates provenance attestations. The publication job is event-gated to tag
   pushes and must remain skipped. Diagnose any failure before creating a tag.
6. **Tag and push — this is the release, and it is a human act:**

   ```
   git switch main && git pull --ff-only
   git tag -s vx.y.z -m "Mirafold Desktop vx.y.z"
   git push origin vx.y.z
   ```

   The tag push triggers `.github/workflows/release.yml`: main-tip guard,
   tag↔version guard, script-free pinned install with signature verification,
   tests, native Linux + Windows builds, packaged and NSIS smoke checks,
   read-only APT signing job, 17-file contract check, provenance attestation,
   then the write-capable publish job. The signing job and publisher each run
   in the `manual-release` environment and wait for Kyle's approval in the
   Actions UI before they may use the archive key or create the release.
7. **Verify the same day**: the run is green including both guards; the
   Release page shows all 17 files and `latest`; download one installer
   anonymously and check its SHA-256 against `SHA256SUMS-<platform>.txt`.
8. **Close the loop — do not skip**: bring `main` back into `next` so the
   next cycle's release branch does not conflict. Keep `next` closed to new
   merges from the time the release branch is reconstructed until this sync
   merges; if it advanced, stop and reconcile that staging work explicitly.

   Do not point the sync branch directly at `origin/main`. Squash/rebase merges
   give equivalent content different ancestry, so that shortcut can expose old
   production commits as new pull-request commits and fail DCO. Instead, start
   on current `next`, reconstruct the exact production tree in the index, and
   certify that reconstruction with one new signed-off commit:

   ```
   git fetch origin
   git switch -c sync/main-into-next-vx.y.z origin/next
   git diff --binary origin/next origin/main | git apply --index
   git diff --cached --quiet origin/main
   git diff --quiet
   git diff --cached --check
   git commit -s -m "sync: main into next after vx.y.z"
   git push -u origin sync/main-into-next-vx.y.z
   gh pr create --base next --head sync/main-into-next-vx.y.z \
     --title "sync: main into next after vx.y.z" --body "Release sync. No review needed beyond green checks."
   ```

   Both quiet comparisons must exit zero: the index equals production and the
   working tree equals the index. Review the staged patch, then merge the PR on
   green (squash or rebase is fine — the content is what matters). Do the same
   sync whenever Path A has published and you are about to cut a manual
   release; step 2 handles the case where you forgot.
9. Delete the merged `feature/*`, `release/*`, and `sync/*` branches
   (`delete_branch_on_merge` does most of this).

## Hotfixes

Same as Path B in miniature, starting from `main`: cut `release/x.y.(z+1)`
**from `main`**, commit fix + bump there (signed off), PR → `main`, merge on
green, tag, verify — then the same `main` → `next` sync.

## Holding a feature out of a release

Don't merge it into `next` yet — that is the whole mechanism. If something
already on `next` must not ship: cut `release/x.y.z` from the last good
commit before it, or revert the unwanted merge on the release branch only.
There is no second staging branch, deliberately.

## Recovering from a bad release

Forward only. Rebuild the last known-good source as a **new, higher** Desktop
version through Path B; installed apps move forward through the same verified
path. Never delete or replace a published asset under an existing tag —
`RELEASE-RECOVERY.md` explains why and what the retry states are.
