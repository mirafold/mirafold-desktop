# Phase 13 release-preparation review

Scope: the release-input/promotion delta from audited `838e508`, authorized by
Kyle's next `$next` after the preflight and release-preparation explanation.
This prepares DPC.10; it does not freeze a candidate or start DPC.11.

## Implementation and review scope

Close-read: new `scripts/release-candidate.mjs`, new candidate tests, the full
Release workflow and its changed policy tests; release-contract and APT
verification interactions; package/version inputs and release-note gate;
README, release runbook, and prior preflight. The independent cold review also
traced Shell intake's separate writer and its existing `[skip ci]` tag behavior.
The runtime source and installed dependency graph have no changes; those
remain covered by completed DPC.7–DPC.9 and are outside this delta review.

The main-only first-attempt dispatch builds/signs/verifies/attests the 17 files,
then retains them with candidate.json for 90 days. The manifest contains source
commit, canonical repository/workflow, run, versions, and every asset's SHA-256
and size. A later annotated tag selects an exact run and manifest SHA-256.
A read-only job resolves the successful main dispatch and immutable artifact;
the protected publisher downloads that artifact ID and repeats live checks
after approval, before validating the manifest, all files, APT signatures, and
existing release contract. Its tag path never rebuilds or re-signs.

Only the isolated signing job receives the archive private key. Dependency
jobs have read-only tokens; the publisher runs standard-library code only.
No new project dependency, environment-policy change, or signing authority was
introduced. The main-only environment and existing manual reviewer were
confirmed through GitHub's read API. The selected action's pinned action.yml
and actual run/artifact API responses confirm its supported inputs and field
types. No tag protection rule is assumed; tag push requires repository write
access and public publication still requires the protected environment.

## Proven findings and repairs

1. **Command integration was untested.** Removing the live main-tip comparison
   or either verify-command selection comparison still passed the original
   tests. They exercised pure validators and candidate creation, without
   invoking promotion. A new bounded test runs the actual resolve/verify CLI in
   an isolated Git repository, with only GitHub's read API substituted. It
   checks main advancing, wrong selected run/digest, a subsequently failed run,
   paginated artifact selection, and successful recovery. All three original
   mutations now fail. No release implementation edit was needed.
2. **The creation fixture hardcoded release versions.** A cold reviewer proved
   the actual create CLI test passed at 0.4.0/0.9.0 but failed after either a
   Desktop-only or Shell-only bump. It now derives both versions from the
   package the command reads. The reviewer independently verified Desktop-only,
   Shell-only, and simultaneous bumps as well as the original versions.
3. **Documentation corrections.** The review caught the stale signing-job
   comment and an unsupported tag-protection claim; both were corrected to
   match source and live repository settings. The isolated CLI API stub's
   initial CommonJS syntax failed under the fixture's type=module package;
   the actual error identified that harness cause and it was corrected before
   the final mutation run. No speculative product fix was applied.

The mutation ledger records exact edits, original/final selectors, and exit
statuses. All 11 sampled breaking edits are now caught: wrong source/run
attempt/result/workflow; artifact expiry/run; manifest binding; changed file
bytes; live main; expected run and expected manifest selection. Each edit was
restored byte-for-byte before the next probe and the restored focused suite
passed. Other validator cases were read and exercised, not mutation-tested.
No tests were deleted. No source mutations remain.

## Verification

Repository standards: `CONTRIBUTING.md` requires `npm test` on both Linux and
Windows; `CLAUDE.md` requires actual packaged runtime/native-module/teardown
proof for packaging changes and forbids Windows cross-builds. These tests use
Node's existing runner and add no dependency. The two POSIX filesystem/CLI
cases skip on Windows; the production publisher itself runs on Linux.

Three unchanged review baselines passed 340 tests with one existing platform
skip, in 16.59, 17.68 and 17.08 seconds (npm wall time). The independent final
cold review passed all 28 candidate/workflow tests in 4.96 seconds and found
no remaining correctness/security issue. All 373 registry signatures and 53
attestations verify; npm reports zero vulnerabilities. Actionlint 1.7.12
validates release.yml; all 10 deterministic release-rehearsal scenarios pass.
Three final unchanged suites passed 341 tests with one platform skip, in
17.53, 18.39 and 15.32 seconds. The additional command regression adds about
three seconds in isolation. Local packaging initially failed because the
sandbox could not chmod electron-builder's home cache; the same build is being
rerun with that cache permission. Package/hosted results follow at closeout.

The review does not claim a hosted candidate or a public promotion was tested:
that requires the reviewed source on main, a successful nonpublishing dispatch,
and later installed acceptance and explicit publication authority. The local
preparation packages are development validation, never an accepted candidate.
Automated releases remain disabled throughout this work.

Detailed logs, mutation output and extraction driver are retained under
`/home/serrecchia/Projects/mirafold-desktop-dpc10` and adjacent
`mirafold-desktop-dpc10-evidence`; independent review evidence lives under
`mirafold-desktop-dpc10-review-evidence`. The committed ledger is portable; no
unique handoff is stored solely in /tmp.

References checked for the changed GitHub integration:
- https://github.com/actions/download-artifact/blob/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/action.yml
- https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run
- https://docs.github.com/en/rest/actions/artifacts#list-workflow-run-artifacts
