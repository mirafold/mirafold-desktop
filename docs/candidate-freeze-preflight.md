# Candidate freeze preflight — 2026-09-07

**Historical preflight, followed by authorized preparation.** Kyle invoked
`$next` after the release-preparation explanation. That pass has implemented
Desktop 0.4.0 / Shell 0.9.0 inputs and accepted-artifact promotion; verification
is in [the preparation review](audits/phase13-release-preparation.md). The
observations below describe the unchanged 838e508 starting point, not the
resulting implementation. No candidate freeze or publication has occurred.

Desktop Step 13.10 / DPC.10 is blocked before any candidate build. The audited
source is `838e5082269dde4092106f507d654bc239edaf64`. The prior code and test
audits remain complete; this preflight found release-preparation work absent
from the freeze sequence. No candidate exists and none should be described as
frozen or accepted.

## Verified starting state

1. **The candidate still has the published version.** Both the audited
   package.json and current production main declare Desktop `0.3.16` with
   Shell `0.9.0`. GitHub's latest release is already `v0.3.16`, published
   2026-09-06 at 05:03:15 UTC, with all 17 assets. Production main is
   `2d107f41818071fb0596920586bd97e6d3491cc6`. The release runbook requires a
   new version for a Desktop release. Its minor-version rule for new
   capabilities suggests `0.4.0` for Linux Pro activation; the GitHub tag
   inventory currently contains no `v0.4.0` tag.

2. **The existing release-notes gate fails on the audited commit.**
   `.github/RELEASE_NOTES.md` still names Desktop `0.3.13` and Shell `0.8.3`.
   Running `node scripts/verify-release-notes.mjs` on the untouched snapshot
   exits 1 with: `release notes verification failed: release notes must begin
   with the exact ## Included versions block`. This is a release-input
   mismatch, not a failure of the product tests.

3. **The full hosted rehearsal cannot build this staging commit.**
   `.github/workflows/release.yml` requires `refs/heads/main` for every manual
   rehearsal, before dependencies or native builds. Executing that exact
   checked-in guard locally exits 1 for `refs/heads/next` and 0 for
   `refs/heads/main`. The live `automated-release` signing environment also
   admits only the `main` branch. Dispatching the existing workflow from
   `next` would fail the same guard; dispatching from current `main` would
   build production's older tree. Neither proves the audited snapshot.

4. **The existing publisher rebuilds instead of promoting frozen files.**
   The tag-triggered Release workflow unconditionally runs electron-builder
   in its native build jobs. Its publisher depends on those build, APT and
   attestation jobs and downloads artifacts from that same workflow run.
   There is no selected earlier candidate run or artifact input. This cannot
   supply the planned build-once, accept, then publish-the-accepted-files
   sequence. No claim about reproducible build hashes is needed: the missing
   promotion path is directly visible in the workflow.

Read-only proof output is saved beside HANDOFF.md as `dpc10-preflight.log`.
The latest release is
https://github.com/mirafold/mirafold-desktop/releases/tag/v0.3.16 .
`MIRAFOLD_AUTOMATED_RELEASES` remains `disabled`.

## Prerequisite scope, subsequently authorized

Prepare the release inputs and the artifact-promotion path before attempting
the freeze again. The concrete scope for Kyle to authorize is:

- Modify package.json, package-lock.json and `.github/RELEASE_NOTES.md` for a
  new Desktop release (recommended `0.4.0`, still bundling exact Shell
  `0.9.0`) describing the already implemented Linux behavior.
- Modify the release workflow and its contract checks so an immutable,
  reviewed candidate can be built and retained without publication, and the
  later protected publisher verifies and reuses the accepted artifacts rather
  than running another build. Preserve signing-key isolation and existing
  protection; do not loosen the main-only signing environment to unblock a
  branch dispatch.
- Add candidate-identity, artifact-hash and promotion regressions to the
  release test suites and persist a candidate manifest contract. Update the
  release runbook and plan to describe the executable sequence.
- Run the affected correctness, security and test reviews on those changed
  release inputs before selecting a new immutable candidate commit.

Runtime activation, encrypted storage, renderer permissions, published Shell
code and the existing public release stay behaviorally unchanged. This
prerequisite would not publish, deploy, enable automatic releases, or perform
the later real purchase/installed acceptance procedure.

Step 13.10 explicitly excludes source, dependency, workflow and package-content
changes from the freeze pass. This prerequisite was therefore proposed separately and subsequently authorized
by Kyle's next `$next`, rather than performed inside the unchanged-input freeze. DPC.11 and all publication steps remain dependent on a
successfully frozen candidate.
