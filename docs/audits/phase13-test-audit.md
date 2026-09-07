# Phase 13 test audit — 2026-09-07

Scope: Desktop Step 13.9 / DPC.9, starting at merged `next`
`ba17aed5781af465422de74aaa064b1d56466a15`. This pass changes tests and audit
documentation. Runtime source, release scripts, dependencies, workflow policy,
and package configuration retain their starting bytes. DPC.10 is not started.

## Standard and method

The repository's CONTRIBUTING.md requires that “`npm test` must pass” on both
Linux and Windows. CLAUDE.md requires that “Windows packages must be built on
a Windows runner” and that packaging verification exercise “both native
modules” outside the development checkout. Step 13.9 requires mutations “in
product code—not comments or the proof itself” and “three unchanged full
suites.” Kyle's test-audit procedure requires a named failure, an observed
surviving mutation before repairing a test, exact restoration between
experiments, and a fresh reviewer before commit.

Each experiment changed one product expression or statement, ran only the
selected test or tests, restored the exact original file bytes, verified their
SHA-256, and reran the selected tests. JavaScript mutations passed syntax
checking before execution. The runner checks that the requested test name
actually ran: a passing Node test-file wrapper is insufficient. Two initial
name selections matched no test; these observations were discarded and rerun
with corrected selectors. An occupied-port mutation initially exposed an
assertion followed by an unclosed fixture listener; the exact-port test gave
the same behavioral failure without that fixture hang.

[The mutation ledger](phase13-test-mutations.json) preserves all 62 distinct
edits, their test selectors, source hashes, initial and final exit status, and
failure evidence. After repairs, 61 behavior-breaking mutations were caught.
One edit removed a redundant cleanup-reference guard, but the independent
`daemonCleanupBlocked` check still refused installation; it did not break the
claimed behavior and is not a test finding. Removing the actual installer
permission check failed its test. No product edits remain.

## Six confirmed test findings, all repaired

1. **Missing durability protection.** Removing
   `await temporaryHandle.sync()` survived the ciphertext round-trip,
   directory-sync, and interrupted-rename tests. They observed visible files
   but never made a ciphertext-file flush fail. The added store test injects
   that failure, requires zero renames, preserves the previous ciphertext and
   key, and requires temporary-file cleanup. The same removal now fails.

2. **Weak pending-state readback test.** The “missing or changed readback”
   test returned only `null`. Removing the saved-flow comparison or the
   renewal-key comparison still passed. Its eleven cases now independently
   exercise missing data, changed schema-valid port, nonce, state, PKCE pair,
   creation and expiry timestamps, and added, removed or replaced renewal
   keys. Each requires failure before browser launch and a closed listener.
   Both surviving mutations now fail.

3. **Wrong-target callback-method fixture.** Node's HTTP client adds a
   `Content-Length: 0` header to a bodyless POST. The existing test therefore
   passed with the GET-only guard removed: the separate body-header guard
   refused it. Six raw requests now vary only the method while retaining a
   correct Host, path, code and state and omitting body headers. The original
   mutation fails on the first POST; valid GET remains covered.

4. **Wrong-target exchange-status fixture and missing response identity.**
   The 403 fixture also had an invalid response body, masking a removed status
   check. No fixture changed the final response URL. Both guard removals
   survived. The response table now combines an otherwise valid key with five
   disallowed statuses, a different URL, and a redirected result, and includes
   independently malformed key types and bounds. The original mutations fail;
   the valid response still succeeds after refusals.

5. **Weak purchased-key confirmation test.** The uncertain-write fixture
   always read back the correct replacement. Removing the exact-key check or
   the pending-state check survived. The real main-process probe now returns
   a wrong key, retained pending state, wrong version, or missing state after
   both a reported successful save and a save error. All eight cases require
   the current daemon to keep running, no success message, and a later trusted
   marker to retry the same purchased key without another browser exchange.
   Both surviving mutations now fail.

6. **Weak stale-browser progress assertion.** The old and new browser flows
   displayed the same progress text. Removing the old URL ownership check
   wrote that same text and passed. The probe now also delays the new flow's
   secure save, delivers the old browser failure while “Saving Pro access
   securely” is visible, and requires that exact progress to remain. It then
   releases the save and verifies successful completion. The mutation now
   fails on the stale progress overwrite.

These are six test-design causes, represented by nine originally surviving
mutations. Existing tests were extended and one filesystem regression was
added. No test was deleted or weakened; no dependency or test tier was added.
The bounded input tables and lifecycle probes remain in the normal suite.
No product bug was identified by these experiments.

## Contract evidence and boundaries

| Contract | Mutation evidence |
| --- | --- |
| Secure Linux provider, ciphertext-provider downgrade refusal, owner identity and no-follow files | S01–S05 |
| Parent, ciphertext-file and post-mutation durability; expiry, rotation and strict schemas | S06–S11 |
| Independent activation randomness, durable pending readback before browser open | A01–A04 |
| Exact callback method, Host and state; one simultaneous exchange | A05–A08 |
| No redirect following, strict exchange response, declared size bound and full exchange deadline | A09–A13, A15 |
| Resume the saved port, shutdown cancellation, listener header bound, exact code/verifier body | A14, A16–A18 |
| Purchased-key confirmation, preflight ordering, stored-key startup, failed removal/update retry | M01–M07 |
| Removal consent, terminal cleanup, quit cancellation, stale browser ownership, installer permission | M08–M14, L01–L03 |
| No ambient key in Linux launch, EOF handoff buffer clearing, credential redaction | D01–D03 |
| Actual `Daemon.start` and published Shell private-pipe boundary | D04–D05 |
| Trusted native activation marker and fail-closed Linux/Windows process ownership | N01, T01–T02 |
| Packaged Shell identity, fixed diagnostic allowlist, dotenv packaging exclusion | P01–P03 |
| Paginated security inventory, pinned owner/App identity, merged-PR requirement, exact API defaults | R01–R05 |

The ledger is a sample of named invariants, not exhaustive mutation coverage.
The surrounding store, activation, navigation, daemon, main lifecycle,
ownership, package-smoke and hardening tests were inspected to choose those
experiments; tests outside the ledger are not claimed as individually
falsified. The published Shell is consumed unmodified. Its own internals were
not mutated. Native Electron keyring implementation, operating-system kernel
behavior, live purchase, and production APT acceptance are not established by
mocked unit tests; prior native evidence and the later acceptance steps retain
their distinct roles. The dotenv packaging case tests the configuration
contract without creating, opening, or reading a dotenv file.

## Verification and suite health

The three unchanged baseline runs each passed 318 tests with one platform
skip, in 13.79, 15.30 and 14.42 seconds. Dependency-tree validation and the
ten-scenario non-publishing release rehearsal passed. npm found zero reported
vulnerabilities and verified 373 registry signatures and 53 attestations.
The first signature check could not write npm's read-only cache; the approved
rerun completed successfully without changing dependencies.

The three unchanged final runs each passed 330 tests with one existing platform
skip, in 18.08, 16.53 and 17.62 seconds. No result differed across either set
of three runs. The additional fixture cases cost approximately three seconds
per full run on this machine. Syntax and whitespace checks passed.

All 42 tracked runtime, build, dependency and release-input files match the
base byte-for-byte. The retained DPC.8 packages were reused after that identity
check; rebuilding a test-only change would produce no new runtime evidence.
Unpacked Linux and independently extracted AppImage, tar and Debian forms each
passed native-module, render-MCP, daemon authentication, and complete shutdown
smokes. Every artifact's 17 runtime source files matched this worktree.
Detailed package evidence is in `dpc9-unpacked-smoke.log` and
`dpc9-artifact-smoke.log` beside the local handoff.

The fresh cold reviewer independently passed all three changed suites
(88 tests, 13.43 seconds) and found no executable-test issue. The reviewer
caught an evidence-record omission: initial and final test selectors differed
for two mutations. Both selectors and their actual test result names are now
recorded and the reviewer verified the correction. Final verdict: no remaining
findings (`dpc9-cold-review.log`). Hosted CI run
[`34166008224`](https://github.com/mirafold/mirafold-desktop/actions/runs/34166008224)
passed Linux and Windows, including the real Windows packaged lifecycle.
DCO passed. Automated review on
[PR #64](https://github.com/mirafold/mirafold-desktop/pull/64) completed on
implementation commit `0dbf6a5` without findings. The closeout follow-up
updates only PLAN.md and this report; the reviewed tests remain unchanged.

The active worktree and ignored detailed logs are retained under
`/home/serrecchia/Projects/mirafold-desktop-dpc9`; the exact local mutation
runner, byte backups and per-experiment logs are in the adjacent persistent
`mirafold-desktop-dpc9-evidence` directory.
