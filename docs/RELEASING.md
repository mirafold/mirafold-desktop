# Releasing Mirafold Desktop — branches, versions, tags

Adopted 2026-08-17, ahead of the first public Desktop launch. It is the same
flow the `mirafold` Shell repository uses, with one addition this repository
needs: most Desktop releases are cut by automation, not by a person. One
principle generates every rule here:

> **`main` is the production mirror: it advances only at release time, so the
> code on `main` and the installers people download are always the same
> thing.**

"Production" is the GitHub Releases feed — the nine files per version that the
installed app's updater reads (`README.md` → *How updates work*). `main` is
protected so that it can move in exactly two ways, and both are releases.

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

## Path A — automated: a new Shell version becomes a Desktop release

This is the routine path and needs no person once it is enabled. The
`Shell intake` workflow (`.github/workflows/shell-intake.yml`) polls npm's
`mirafold` `latest` tag twice an hour. When it changes, the workflow proves the
package's npm provenance back to `mirafold/mirafold`'s release workflow, pins
the exact version, bumps the Desktop patch version, tests on both platforms,
builds and smoke-checks native Linux and Windows packages, attests provenance,
and then — in one isolated job that installs no dependencies — commits the
version bump, tags it, pushes commit and tag atomically to `main` (the ruleset
bypass), and publishes the verified nine-file GitHub Release. Retries resume;
nothing partial ever becomes visible.

It is dormant until the repository variable `MIRAFOLD_AUTOMATED_RELEASES` is
exactly `enabled`. It stays dormant through the one-time updater bridge
release (Path B, below), which must exist first so that installed users can
receive what Path A publishes.

`README.md` → *Automated Shell releases* has the full contract;
`RELEASE-RECOVERY.md` has the failure and retry states.

## Path B — manual: a Desktop-only release

For changes to this repository itself (the shell, the updater, packaging), and
for the one-time bridge release.

1. **Feature work**: branch off `next`, commit with `-s`, open a PR into
   `next`. Keep follow-ups on that PR; ask Kyle for merge approval when it
   appears ready. Repeat until `next` holds the release you want.
2. **Fold in `main`** (only matters if Path A has published since `next` last
   synced): `git switch -c release/x.y.z origin/next && git merge origin/main`.
   The only expected conflict is `package.json`/`package-lock.json` versions —
   keep the newer Shell pin, then apply the bump below.
3. **Bump the Desktop version** in `package.json` and `package-lock.json`
   (`npm version x.y.z --no-git-tag-version` does both) — commit
   `release: vx.y.z` (signed off).
4. **PR `release/x.y.z` → `main`**, merge on green.
5. **Tag and push — this is the release, and it is a human act:**

   ```
   git switch main && git pull --ff-only
   git tag -s vx.y.z -m "Mirafold Desktop vx.y.z"
   git push origin vx.y.z
   ```

   The tag push triggers `.github/workflows/release.yml`: main-tip guard,
   tag↔version guard, script-free pinned install with signature verification,
   tests, native Linux + Windows builds, packaged and NSIS smoke checks,
   nine-file contract check, provenance attestation, then the write-capable
   publish job — which runs in the `manual-release` environment and waits for
   Kyle to approve it in the Actions UI before it creates the release.
6. **Verify the same day**: the run is green including both guards; the
   Release page shows all nine files and `latest`; download one installer
   anonymously and check its SHA-256 against `SHA256SUMS-<platform>.txt`.
7. **Close the loop — do not skip**: bring `main` back into `next` so the
   next cycle's release branch does not conflict:

   ```
   git fetch origin
   git push origin origin/main:refs/heads/sync/main-into-next-vx.y.z
   gh pr create --base next --head sync/main-into-next-vx.y.z \
     --title "sync: main into next after vx.y.z" --body "Release sync. No review needed beyond green checks."
   ```

   Merge it on green (squash is fine — the content is what matters). Do the
   same sync whenever Path A has published and you are about to cut a manual
   release; step 2 handles the case where you forgot.
8. Delete the merged `feature/*`, `release/*`, and `sync/*` branches
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
