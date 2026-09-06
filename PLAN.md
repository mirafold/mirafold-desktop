# Mirafold Desktop — plan

Started 2026-08-02. The goal is a download other people can install and run on
the supported platforms, with the unsigned direct-download boundary stated
accurately.

## Active program — continuous, hardened Desktop delivery

Started 2026-08-13 after the first full product/repository audit. This is an
**oversized feature program**: each Phase is a large outcome and each numbered
Step is one independently executable pass. `$next` completes exactly one Step,
records its evidence here, and stops. A Step is not complete when only its code
exists; its stated verification must also pass.

### Outcome

Someone who installs the bridge release once should thereafter receive tested
Mirafold Shell releases through the Desktop's own update channel. Kyle should
do no routine Desktop work after publishing Shell. Windows and supported Linux
packages should update through GitHub Releases at no service cost. A separate
Microsoft Store package should use the Store's free signing and update channel
if the real application passes Store packaging, certification, and Windows
tests.

### Verified starting state (2026-08-13)

- `package.json` requests `mirafold` `^0.3.0`, while `package-lock.json` freezes
  the shipped copy at `0.3.0`. npm's current `latest` is `0.3.7`; its registry
  metadata includes an npm/SLSA provenance attestation from
  `mirafold/mirafold`'s release workflow.
- `src/main.js` contains no updater and `package.json` has no
  `electron-updater` runtime dependency. Installed `v0.1.1` applications never
  check for a newer release. Those installations therefore require one manual
  bridge installation before later updates can be automatic.
- `.github/workflows/release.yml` runs only for a Desktop `v*` tag or a manual
  rehearsal. It builds the current lockfile and uploads only `.deb`, `.tar.gz`,
  `.AppImage`, and `.exe` files; it neither consumes a Shell release nor uploads
  updater metadata/blockmaps.
- `electron-builder.yml` already uses the Windows per-user NSIS target needed
  by `electron-updater`. Its Linux targets are `.deb`, `.tar.gz`, and
  `.AppImage`. Exact automatic-install behavior still must be proven for each
  packaged Linux form; a tar archive has no owning package manager and must at
  least receive an in-app download notification.
- `src/daemon.js` redacts an intact `?token=...` substring independently in
  each stream chunk. A direct split-chunk probe exposed the token, and the
  upstream relay pairing credential is printed on stdout without matching that
  expression. Both can therefore reach the Desktop process's inherited system
  log. This is observed incorrect behavior.
- `src/navigation.js` allows every HTTP URL whose hostname is `127.0.0.1`,
  regardless of port. `src/main.js` does not install Electron permission check
  or request handlers. These are missing trust boundaries: the window should
  allow only the one daemon origin returned by the current child and no web
  permissions.
- The current Windows artifact is an unsigned NSIS executable. It has been
  structurally inspected but never installed or run on real Windows hardware.
  Microsoft Store/MSIX packaging does not exist.
- The release workflow already separates read-only build jobs from the one
  write-capable release job. It still uses moving action tags, has no packaged
  launch smoke test, and the repository has no ruleset or protected `main`.

### Approved boundary

**Modify existing:** `src/daemon.js`, `src/navigation.js`, `src/main.js`,
`electron-builder.yml`, `package.json`, `package-lock.json`,
`.github/workflows/release.yml`, the associated tests, `README.md`,
`SECURITY.md`, `WINDOWS-TESTING.md`, and this plan.

**Create new:** a small main-process updater module, pure update/release helper
modules and tests, a scheduled Shell-intake workflow, packaged smoke checks,
and a self-contained Microsoft Store guide/configuration once Partner Center
provides the application's real identity values. Exact filenames are chosen in
the Step that implements them and recorded here; no placeholder Store identity
will ship.

**Leave behaviorally unchanged:** Mirafold's child-process architecture, the
absence of preload/IPC/renderer Node access, project-folder selection, daemon
crash recovery, existing agent and credential ownership, and the three Linux
plus NSIS packaging choices. Product UI and daemon behavior remain upstream in
the published `mirafold` package.

### Release architecture decision

The Desktop repository will **pull**, not accept a privileged push from the
Shell repository. A scheduled and manually dispatchable Desktop workflow will
read npm's `mirafold` `latest` tag, require its npm provenance, and compare it
with the exact locked version. This needs no cross-repository personal access
token. Concurrency will serialize runs and a new run will re-read `latest`, so
several rapid Shell releases may coalesce into one Desktop release containing
the newest one. That is intentional: installed users need the newest tested
stable Shell, not forced installation of every intermediate build.

Desktop and Shell keep separate versions. Every accepted Shell change bumps
the Desktop patch version and records both versions. Desktop-only fixes can
also bump the Desktop version without inventing a Shell version.

### Phase 3 — current core and desktop trust boundaries

All five steps completed 2026-08-13 (baseline verification; exact
`mirafold@0.3.7`/Electron 43.4.0 pins; stream-safe credential redaction;
exact daemon-origin navigation plus deny-all permissions; hardened packaged
verification) → archived in PLAN-ARCHIVE.md.

### Phase 4 — the one-time bridge and Windows/Linux updater

All four steps completed 2026-08-13 (electron-updater integration gated on a
proven clean shutdown; the complete nine-file release contract with atomic
publication; per-form Linux update proof for AppImage/deb/tar; the full local
bridge, checksum-rejection, defer, and forward-only-recovery rehearsal) →
archived in PLAN-ARCHIVE.md.

### Phase 5 — zero-routine-work Shell-to-Desktop releases

All five steps completed 2026-08-13 (deterministic release preparation;
scheduled provenance-verified Shell intake; native builds plus the isolated
writer with race/retry safety; action pinning, provenance, manifests, and the
exact repository-hardening policy; the ten-scenario non-publishing rehearsal
on real Linux/Windows runners) → archived in PLAN-ARCHIVE.md. The writer
stays dormant until the repository variable `MIRAFOLD_AUTOMATED_RELEASES` is
deliberately set to `enabled`, which happens only after the Step 7.3 bridge.

### Phase 6 — Windows proof and the free Microsoft Store channel

- [x] **Step 6.1 — add Windows packaged smoke coverage.** On the Windows CI
  runner, verify the packaged application can resolve and load both native
  modules, start the real bundled daemon far enough to validate its URL
  contract, close it without descendants, and silently install/uninstall the
  per-user NSIS candidate where runner capabilities permit. Keep human-only
  behavior explicitly separate.

  **Completed 2026-08-14 — the real Windows package and assisted NSIS lifecycle
  are now runner-proven.** The verified starting point was narrower than this
  Step requires. Existing `scripts/packaged-smoke.mjs` resolved the bundled
  daemon entry and loaded `@lydell/node-pty` and `@parcel/watcher` through the
  packaged Electron runtime, but it did not start the daemon, make an HTTP
  request, prove process-tree shutdown, or touch an installer. The release and
  Shell-intake workflows ran that check against `win-unpacked`; neither had an
  NSIS install/uninstall step. The existing assisted NSIS configuration was
  already per-user-capable (`oneClick: false`, `perMachine: false`, changeable
  destination), so this Step changed validation rather than the shipped
  installer configuration.

  The existing packaged smoke now imports the packaged Desktop `Daemon`, starts
  the exact bundled Shell entry from an empty isolated project, and validates
  the private IPv4-loopback URL without printing its token. It proves the
  Shell's real token-to-cookie handshake (`302` to `/`, token-bearing
  `HttpOnly`, `SameSite=Strict`, root-scoped cookie), then proves a
  cookie-authenticated `200` HTML response, clean `Daemon.stop()`, an
  unreachable URL after shutdown, no crash callback, and zero remaining
  `Mirafold.exe` images through native `tasklist.exe`. Both the manual release
  workflow and every Windows Shell-intake candidate run this same check.

  New `scripts/windows-installer-smoke.mjs` uses only Node's standard library.
  On Windows it installs the real `Mirafold-Setup-VERSION.exe` silently with
  explicit `/currentuser` mode into one unique runner-temp directory and keeps
  NSIS `/D=` last. It requires the installed executable, packaged app tree, and
  uninstaller; enumerates both 64- and 32-bit registry views; requires an HKCU
  reference to the exact unique install directory and no HKLM reference; runs
  the complete native-module and live-daemon smoke against the installed bytes;
  then copies the uninstaller outside `$INSTDIR` and invokes it with the
  electron-builder-compatible `_?=<install directory>` argument last. It waits
  for removal and proves the install directory plus both user and machine
  registration views are gone. A failure after installation still attempts the
  same detached silent cleanup. No dependency, package pin, or lock entry was
  added or changed.

  **Diagnosed runner failures, without changing Desktop runtime code:** the
  first native Windows run proved the unpacked daemon but exposed insufficient
  installer diagnostics. Failure-only reporting then made three independent
  harness defects observable. First, a legacy `powershell.exe` process-count
  helper succeeded once and timed out twice on identical hosted runs; replacing
  that redundant shell layer with native `tasklist.exe` made the same zero-image
  assertion stable. Second, `reg.exe /f ... /e` returned the normal
  `End of search: 0 match(es) found.` result because `/e` demanded a whole-value
  match, while the allowlist did not recognize that wording. Unfiltered
  enumeration then directly found the unique install path in both HKCU views
  and none in HKLM. Third, running the in-place uninstaller returned zero but
  left the directory after two 30-second waits. The installed
  `electron-builder@26.15.3` template showed its own waited removal contract:
  copy the uninstaller out of the application directory and execute that copy
  with `_?=$INSTDIR` last. The probe now follows that exact contract; the next
  hosted run removed the directory and registration cleanly.

  **Exact hosted proof:** nonpublishing workflow run
  `31770520381` at commit
  `cb4747912254113fe95f5f762c32af9cdef16401` completed successfully. Windows
  job `94675311684` and Linux job `94675311729` each installed dependencies,
  passed the full suite, built native artifacts, passed their packaged-runtime
  smoke, generated canonical SHA-256 manifests, verified the updater artifact
  contract, and uploaded the candidates. The Windows lifecycle reported
  current-user installation, HKCU registration in both registry views, no HKLM
  registration, Desktop `0.1.1`, Shell `0.3.7`, both native modules loaded, the
  hardened `302`/cookie/`200` daemon handshake, proven process-tree shutdown,
  zero residual `Mirafold.exe` images, successful uninstall, removed install
  directory, and removed registration. Windows artifact `9208092652` is bound
  to digest
  `sha256:227793df5732de460fef831a99ff021274fd29f5246f919a483c961333f066e1`;
  Linux artifact `9208092475` is bound to
  `sha256:33ddc6b06761b4cb26db79d2750a4648d9fcaaacf52f05f99ec0f61914e225ea`.
  Provenance job `94676603742` verified and attested all nine release files;
  the publication job was skipped.

  **Local and boundary verification:** the final suite passes **141/141**;
  focused packaged/NSIS/workflow tests pass; both changed scripts pass syntax
  checks; workflow YAML parses; `git diff --check` passes; the existing real
  Linux unpacked package independently repeats the `302`/hardened-cookie/`200`
  handshake and clean shutdown; `npm audit --audit-level=moderate` reports zero
  vulnerabilities; all 376 registry signatures and 56 attestations verify; and
  `npm ls --all` is clean apart from expected absent-platform optional
  packages. Remote `main` remains
  `bee5bd51b127c086114a6833004b34d8c04faf39`; `v0.1.1`, the two existing
  published releases, and an empty Actions-variable set remain unchanged. No
  tag, draft, release, repository setting, writer activation, or merge was
  created.

  **Change boundary and limits:** executable changes in this Step are confined
  to the two validation scripts and the two existing workflow call sites;
  shipping `src/**`, the installer configuration, the Shell pin, and dependency
  resolution are behaviorally unchanged. Tests add fake daemon authentication,
  token-leak rejection, native Windows process enumeration, both registry views,
  cleanup, and detached-uninstaller contracts. README changes document the
  stronger automated proof and its limits. A hosted process cannot truthfully
  observe SmartScreen, visible wizard/folder-selection behavior, real agent and
  ConPTY interaction, filesystem watching, or a human-driven automatic update
  and restart. Those remain explicitly unverified for Step 6.2.
- [ ] **Step 6.2 — test direct-download Windows with a human.** Refresh
  `WINDOWS-TESTING.md` for the bridge/updater and walk Kyle through recruiting a
  Windows tester one action at a time. Observe SmartScreen, installation,
  folder selection, agent response, ConPTY command, filesystem watching,
  automatic update, restart, and zero leftover processes. No public launch
  claim precedes this evidence.

  **Preparation completed 2026-08-14; human evidence remains pending and this
  Step stays open.** The verified starting guide existed at
  `WINDOWS-TESTING.md`, but it still directed a tester to the updater-less
  public `v0.1.1`, predicted warning behavior instead of recording it, claimed
  every supported agent's existing login would work, and instructed a tester
  to create a secret-bearing project dotenv file. Mirafold Shell `0.3.7`'s
  documented provider policy instead supports a local Codex/ChatGPT login,
  while Claude and Gemini subscription logins alone are blocked for this
  third-party application path. The guide now prefers an already-working local
  Codex login, discloses that the two expected live turns use the tester's own
  provider account, forbids credential sharing and project credential setup,
  and uses an empty disposable folder.

  The human gate is now split at the real release boundary. Session A tests the
  exact current private candidate's visible installer, folder picker, live
  provider, Windows ConPTY, watcher, Help versions, ordinary shutdown, and
  uninstall. Session B remains blocked on the separately approved public bridge
  and a later higher release; it proves anonymous direct download, startup
  discovery, cached **Later**, explicit installation/restart, version movement,
  and final process cleanup. This is necessary rather than optional wording:
  the existing public `v0.1.1` Release was directly inspected and contains only
  four install payloads, with no `latest.yml`, block map, checksum manifest, or
  updater runtime in the package. It cannot discover a successor. The private
  rehearsal candidate contains the updater but is also numbered `0.1.1`, so it
  has no higher public target. Candidate evidence therefore cannot be relabeled
  as a production update pass.

  Candidate acquisition is bound to source commit
  `cb4747912254113fe95f5f762c32af9cdef16401`, non-publishing
  [run 31770520381](https://github.com/mirafold/mirafold-desktop/actions/runs/31770520381),
  artifact `9208092652`, its 2026-08-21 retention deadline, the GitHub archive
  digest, exact installer size `250098162`, and installer SHA-256
  `d16eba272b0fd186e5eccb967b0b71bca1ca6dbe64dda3f06451f7f868835939`.
  The downloaded four-file set passed the Windows platform release-contract
  verifier again and its manifest's installer digest matched an independent
  `sha256sum`. No release, tag, repository setting, or public asset was changed.
  This preparation modifies only `WINDOWS-TESTING.md` and this plan; executable
  behavior and tests are unchanged. The next action is the first human-only
  action: identify one consenting Windows 10/11 x64 tester with a working local
  Codex login and no existing Mirafold Desktop installation.
- [ ] **Step 6.3 — establish the correct free Store identity.** Walk Kyle one
  action at a time through the correct Microsoft developer account type,
  verification, name reservation, and retrieval of the real Partner Center
  package identity. Both account types are now free, but Store Policy 10.14
  requires Company for business/trade publication and Partner Center cannot
  convert Individual to Company. Identity/business evidence remains Kyle's; no
  private evidence or secret is pasted into chat or stored in this repository.

  **Preparation completed 2026-08-14; external identity evidence remains
  pending and this Step stays open.** Microsoft's current enrollment page,
  Store policies, signing guidance, name-reservation rules, and package-identity
  reference were checked directly. The earlier Individual-account assumption
  is superseded: Individual is documented for personal non-commercial work,
  while Company is required for businesses and people publishing in relation
  to a trade or profession. Mirafold is branded and has a planned paid tier, so
  Company is the present recommendation, subject to Kyle's still-unverified
  real legal/business status. Both routes have zero registration fee through
  `storedeveloper.microsoft.com`; Store submission signs, hosts, and updates
  AppX/MSIX packages for free. Store signing does not sign the direct NSIS
  download, and the Store EXE/MSI route would require Mirafold to buy its own
  CA-trusted signing first.

  New `MICROSOFT-STORE.md` records the account consequences, verified repo
  baseline, no-secret boundary, three exact Partner Center manifest values,
  three-month name-reservation lifetime, future AppX build boundary, and
  one-action-at-a-time evidence ledger. `electron-builder.yml` currently has no
  Store target or identity; `electron-builder@26.15.3` already contains an
  unconfigured Windows AppX target; and the existing `process.windowsStore`
  runtime path plus unit tests suppress GitHub updating only at the policy
  boundary. No account, reservation, package, external setting, or executable
  file changed during this preparation. Store onboarding waits behind the one
  Windows-tester action already assigned to Kyle; no second human action has
  been issued.
- [ ] **Step 6.4 — build and verify the Store package.** After Step 6.3 supplies
  non-secret identity strings, add a separate MSIX/AppX build that preserves
  the direct NSIS channel, disables the GitHub updater under Windows Store, and
  packages the daemon/native children correctly. Inspect the package and test
  it on real Windows before claiming Store compatibility.
- [ ] **Step 6.5 — submit and certify.** Walk Kyle through listing copy,
  screenshots, privacy/policy declarations, package upload, certification
  responses, and a private/hidden availability test one action at a time.
  Publishing broadly remains a separate explicit decision. Verify Store signing
  and Store-delivered update behavior on the installed certified package.

### Phase 7 — truthful documentation, validation, and bridge release

- [x] **Step 7.1 — correct all distribution documentation.** Replace inaccurate
  SmartScreen/certificate and macOS Gatekeeper claims; document exact update
  behavior per package, Desktop-versus-Shell versions, the one-time bridge,
  unsigned direct-download trust, free Store signing, failure/recovery, and
  support boundaries. Keep executable, test, and documentation diffs reported
  separately.

  **Completed 2026-08-14 — the documentation now matches the implemented and
  observed boundaries.** The exact baseline was re-established before editing.
  `src/updater.js` selects direct installation for packaged non-Store Windows,
  AppImage, and Debian builds; selects notice-only behavior for extracted Linux
  archives; never constructs `electron-updater` for Store packages; disables
  install-on-quit and downgrade; asks before stopping the daemon tree; and
  attempts session recovery after an installer-start failure. `src/main.js`
  supplies Electron's real `process.windowsStore` signal and starts the
  background check only after the working application boots. The public
  `v0.1.1` no-updater boundary, hosted current-user Windows lifecycle proof,
  and remaining human observations were already bound to exact release/run
  evidence in Steps 4.4, 6.1, and 6.2.

  Microsoft's current
  [SmartScreen documentation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
  directly contradicts the old claim that buying an OV certificate simply
  removes the warning: unsigned hashes start without transferable reputation,
  signed binaries can still be warned about while reputation accumulates,
  enterprise policy can prevent continuation, and Store-installed apps receive
  Microsoft's signature. Apple's current
  [Gatekeeper guidance](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)
  directly contradicts the old “categorically useless” claim by documenting a
  manual Privacy & Security override. Apple's
  [Developer ID guidance](https://developer.apple.com/support/developer-id/)
  still establishes Developer ID membership, signing, and notarization as the
  normal direct-distribution path. The Store cost/account/package facts and
  their official Microsoft sources remain centralized in
  `MICROSOFT-STORE.md`; the README now links that record without implying that
  a Store package or account exists.

  `README.md` now gives one exact package-by-package update table, independent
  Desktop/Shell versions, the one-time manual bridge, forward-only recovery,
  nonfatal failure behavior, unsigned-download verification, and the human
  Windows/Store limits. `SECURITY.md` now distinguishes release checksums,
  updater hashes, provenance, and operating-system publisher signing.
  `.github/RELEASE_NOTES.md` is now truthful bridge guidance for the manually
  tagged release path that consumes it; the automated Shell writer continues
  to generate separate source-bound notes in
  `scripts/release-coordinator.mjs`. It no longer claims every Claude, Codex,
  and Gemini subscription login works: the installed Shell `0.3.7` policy was
  directly inspected and permits local subscription use only for Codex.
  `CLAUDE.md`, the release-workflow comments, packaging comments, current plan
  decisions/gaps, and one assumption in the Windows protocol now use the same
  boundaries. The AppImage wording was narrowed from an unsupported
  distribution-wide claim to the locally observed FUSE 2 requirement.

  **Verification and change boundary:** the complete suite passes **141/141**;
  48 focused updater, Windows-installer, direct-release, and Shell-intake
  workflow tests pass independently; all five repository YAML files parse; the
  stale-claim sweep returns only historical starting-state text and intentional
  observation prompts; and `git diff --check` passes.
  Executable behavior changed in **zero** files. Test behavior changed in
  **zero** files. Documentation changed in `README.md`, `SECURITY.md`,
  `.github/RELEASE_NOTES.md`, `CLAUDE.md`, `WINDOWS-TESTING.md`, and this plan;
  comments only changed in `.github/workflows/release.yml` and
  `electron-builder.yml`, leaving their parsed configuration behavior
  unchanged. `MICROSOFT-STORE.md` remains the new documentation prepared for
  pending Step 6.3. No Store account, package, identity, repository setting,
  release, tag, installed client, or other external state changed. The only
  currently assigned human action remains recruiting the Windows tester from
  Step 6.2.
- [x] **Step 7.2 — perform final ship-readiness verification.** Re-run unit,
  workflow, dependency, signature/provenance, packaged Linux, CI Windows, update
  transition, and security-boundary checks. Audit the final dependency and
  artifact contents, compare the implementation with this approved boundary,
  and list every remaining unverified real-world claim.

  **Completed 2026-08-14 — verification is complete; the release verdict is
  NOT READY.** No defect was found in the candidate behavior exercised here,
  but the human Windows gate, public bridge, production automation, repository
  protections, and Store work remain incomplete. Before Step 7.3, this work
  must reach `main`, both required CI checks and the repository-hardening audit
  must pass there, Windows Session A must finish, and Kyle must separately
  approve publication. Store certification and the next real Shell intake are
  later validations, not prerequisites to the one-time bridge.

  **Source, dependency, and automated checks:** the inspected checkout is
  branch `step-5-5-release-rehearsal` at
  `e919620`, with Desktop `0.1.1`, exact Shell `0.3.7`,
  `electron-updater` `6.8.9`, Electron `43.4.0`, electron-builder `26.15.3`,
  and npm `12.0.2`. npm still reports `mirafold@0.3.7` as latest, and the
  committed package and lock hashes did not move during verification. The
  complete suite passes **141/141**; all ten release-rehearsal scenarios pass;
  66 focused lifecycle, navigation, permission, updater, packaging, release,
  and hardening tests pass independently; every source/script/test file parses;
  and all five repository YAML files parse. `npm audit --audit-level=moderate`
  reports zero vulnerabilities, `npm audit signatures` verifies all 376
  installed registry signatures and 56 attestations, and `npm ls --all` exits
  cleanly.

  **Fresh Linux package and update proof:** a clean current-checkout build
  produced the AppImage, Debian package, tar archive, stable update metadata,
  and canonical SHA-256 manifest. The packaged smoke resolved the exact daemon,
  loaded both native modules, completed the token-to-hardened-cookie HTTP
  handshake, stopped the complete process tree, and left the URL unreachable.
  Payload, manifest, and Linux platform contracts all passed. The exact
  artifact SHA-256 values are
  `5a38ddc550de4c4a0209606ebcf74003fe9e99e0d5e7a7a17b105f3349feb0d2`
  (AppImage),
  `8a5f43430aebc8bfb6a7bf3c3f01c704c25514ae0bdd56c76d38a09c963b32fd`
  (Debian),
  `d69047f339f6824d07550c5cd3aafb45196e138e54e815a20e3357860293bf04`
  (tar), and
  `1c28176ef65d165dc2c723ac024373ea95e608de1eafbd82e9ecd93769328764`
  (`latest-linux.yml`). The three package forms embed Desktop `0.1.1`, exact
  Shell `0.3.7`, and updater `6.8.9`, with no development scripts or
  development dependencies. The packaged source hashes match the checkout;
  only the expected Linux x64 `node-pty` and glibc watcher native binaries are
  present. Debian alone carries the `deb` package marker, while AppImage and
  tar do not.

  A new isolated `0.1.1` to `0.1.2` local-feed probe repeated the real AppImage
  stop/replace/relaunch path, selected the verified Debian payload and exact
  `dpkg -i` command behind `pkexec` without executing privileged installation,
  and proved that tar metadata opens the fixed Releases URL without stopping
  the daemon or downloading a payload. The full bridge, lower-version refusal,
  and forward-only `0.1.4` recovery remain independently observed in Step 4.4;
  executable update source has not changed since that proof.

  **Windows and provenance re-audit:** the retained candidate from successful
  nonpublishing run `31770520381` still passes the Windows release contract.
  Its installer SHA-256 is
  `d16eba272b0fd186e5eccb967b0b71bca1ca6dbe64dda3f06451f7f868835939`;
  both native build jobs and provenance job are green; publication was skipped.
  GitHub's public attestation API returns one in-toto/SLSA provenance statement
  whose installer subject matches that digest and whose builder, workflow,
  branch, commit, and nine subjects match the run. The installed-candidate
  daemon/native-module/current-user install/uninstall proof remains the exact
  hosted evidence recorded in Step 6.1. The Windows artifact expires
  2026-08-21; this audit did not publish or extend it.

  **Approved-boundary comparison and live security state:** the branch diff and
  current worktree were reviewed together. Executable changes modify only the
  approved release workflow, packaging/package manifests, daemon/main/
  navigation boundaries, and create the approved updater, permission, Shell
  intake, release-validation, CI, Dependabot, and repository-hardening
  components. Test changes cover those components. The current uncommitted
  Step 7.1 work changes documentation and comments only; it changes no runtime
  or test behavior. No Store package/identity, macOS target, preload/IPC bridge,
  renderer Node access, provider credential handling, or upstream Shell source
  was added. Local hardening validation passes every modeled human, Dependabot,
  and writer flow. The read-only live audit correctly rejects the current
  remote state: merge commits remain enabled, merged-branch deletion is off,
  secret scanning and push protection are off, Dependabot security updates and
  private vulnerability reporting differ from policy, and the named ruleset
  plus both release environments are absent.

  **Every remaining unverified real-world claim:**

  1. Remote `main` is still `bee5bd51b127c086114a6833004b34d8c04faf39`;
     this implementation is unmerged, the Step 7.1/7.2 documentation work is
     uncommitted, and the two required CI identities have not succeeded on the
     implementation at `main`. The repository hardening above therefore has
     not been applied. `MIRAFOLD_AUTOMATED_RELEASES` is absent by design.
  2. Session A in `WINDOWS-TESTING.md` still needs an ordinary Windows 10/11
     x64 person to observe SmartScreen/Smart App Control, UAC, the visible
     installer and destination, Start-menu launch, folder picker, a real Codex
     turn, ConPTY, file watching, ordinary close, Task Manager, and uninstall.
     Session B still needs the separately approved public bridge and a later
     public release to observe anonymous acquisition, startup discovery,
     **Later**, install/restart, version movement, and final process cleanup.
  3. Public `v0.1.1` remains the four-payload updater-less release. No public
     bridge, updater metadata, production-feed discovery, anonymous bridge
     download, or installed-client production transition has been exercised.
  4. No genuinely newer Shell exists for intake to consume. The scheduled
     detection, verified writer commit/tag, cross-platform public release, and
     installed-client delivery of a real future Shell publication therefore
     remain unobserved; the writer's live mutation path stays deliberately
     disabled.
  5. The Debian authorization dialog, cancellation, actual privileged `dpkg`
     replacement, and post-install relaunch remain unobserved on a real desktop.
     AppImage host integration outside this Linux machine and tar behavior
     across supported distributions are also not claimed.
  6. No Microsoft developer account type has been established, no Store name
     or Partner Center identity has been obtained, no AppX/MSIX target exists,
     and no package has been submitted, signed, certified, privately installed,
     or updated by the Store. Steps 6.3–6.5 own that work.
  7. Kyle's private GitHub passkey/security-key, offline recovery-code,
     recovery-email, and alert-notification readiness remain unverified and
     must never be supplied to this repository or chat.

  The unsigned direct-download status and the documented hard-kill orphan
  limitation are verified constraints, not missing evidence disguised as
  claims. macOS remains explicitly outside the supported target set. No tag,
  draft, release, repository setting, installed client, Store account, or other
  external state changed during this Step. The only currently assigned human
  action remains recruiting the Session A Windows tester from Step 6.2.
- [ ] **Step 7.3 — publish the manual bridge release.** Only after Kyle's
  explicit release approval, create the public higher Desktop release with the
  updater, current Shell, notes, hashes/provenance, and all update metadata.
  Verify anonymous downloads and production-feed discovery. Existing users
  manually install this release once.
- [ ] **Step 7.4 — validate automatic production delivery.** Let the next real
  Shell npm release be detected without manual Desktop edits, verify the
  resulting cross-platform GitHub Release and installed-client update, then
  record measured timing, failures, and recovery. Complete the program only
  when routine Shell releases require no Desktop intervention.

### Maintenance pass — behavior-preserving release-policy refactor

Both refactors completed 2026-08-14 (Shell-intake validation decomposition;
centralized packaged/NSIS smoke preconditions; zero behavior change) →
archived in PLAN-ARCHIVE.md.

### Maintenance pass — 2026-08-17 modularity and deduplication

Completed 2026-08-17, zero behavior change, 166/166 tests green, plus a
dev-checkout daemon start/403-without-token/clean-stop probe through the new
module graph. `src/daemon.js` (757 lines) split three ways: `daemon.js` keeps
the launch spec, URL contract, and `Daemon` lifecycle; `daemon-output.js` owns
credential redaction and the bounded line stream; `process-tree.js` owns
Linux identity tracking, the ledger, and `terminateProcessTree`. Seven
release/verification scripts now import their shared standard-library helpers
(`invariant`, `STABLE_VERSION`, `readJson`, `exactKeys`, `sha256`,
`canonicalIntegrity`, `appendGithubOutputs`, …) from one `scripts/shared.mjs`;
`release-contract.mjs` deliberately stays self-contained because it is the only
verifier that runs beside the write token, and the import-scan tests now pin
that `shared.mjs` itself is standard-library only. `platform-updaters.js`
factors the duplicated `quitAndInstall` preamble; `updater.js` collapses the
two once-per-version prompt state machines into one `versionPrompt()` helper;
`main.js` uses one parented `showMessage` for every dialog. The previously
orphaned `scripts/linux-update-probe.mjs` is now `npm run update:probe:linux`
and documented in the README.

### Phase 8 — repair the updater and process-lifecycle correctness gaps

All three steps completed 2026-08-14 (identity-checked Linux descendant
tracking that survives daemon crashes; non-destructive AppImage
staging/rollback and acknowledged NSIS launch; ordinary quit gated on proven
cleanup; documentation reconciled to the evidence) → archived in
PLAN-ARCHIVE.md.

### Phase 9 — close the second-pass ownership and release-contract gaps

All three steps completed 2026-08-14 (serialized folder changes with
per-daemon ownership; the Node-mode-scrubbing bootstrap with its synchronous
Linux PTY ledger; the Windows kill-on-close Job Object wrapper; exact
18-byte-BLAKE2b blockmap content verification) → archived in
PLAN-ARCHIVE.md. Still live from this phase: the Windows Job-Object crash
probe is implemented but has **not yet run on a native Windows runner** — its
first result belongs to the next non-publishing run, which must also produce
the fresh candidate `WINDOWS-TESTING.md` now requires in place of the
forbidden pre-Job artifact.

### Phase 10 — signed Ubuntu APT distribution

Started 2026-08-26 after the public `v0.2.0` bridge release. This is an
oversized feature: each Step is one independently executable pass. The outcome
is a real public channel where a new Ubuntu user installs the repository once
and then uses `sudo apt install mirafold-desktop`; later Desktop releases arrive
through Ubuntu's normal package-manager flow.

**Verified starting state (2026-08-26):** GitHub's latest stable release is
public `v0.2.0`, with the exact nine-file release contract and a
`mirafold-desktop_0.2.0_amd64.deb` payload. The package's observed Debian
identity is `mirafold-desktop`, architecture `amd64`. GitHub Actions currently
has no repository or release-environment secrets and the release contains no
APT `Packages`, `Release`, `InRelease`, archive-keyring, or source-definition
assets. Packaged Debian currently selects Mirafold's private verified `.deb`
updater; it cannot distinguish an APT-managed installation. This machine is
Ubuntu 24.04 `amd64` and has no `mirafold-desktop` package installed.

**Distribution decision:** each stable GitHub Release doubles as one signed
flat APT repository. The stable base URI is GitHub's documented
`/releases/latest/download/` asset route, so APT downloads the exact already
verified release `.deb` rather than a duplicated copy on another hosting
service. A dedicated Mirafold APT archive key signs `Release`; it is not Kyle's
personal Git/tag key. A tiny `mirafold-archive-keyring` bootstrap package owns
the public key, deb822 source definition, and an APT-management marker. The
Desktop consults only that marker: repository installations leave updates to
APT, while a direct `.deb` without the bootstrap package retains the existing
in-app updater. Key rotation must overlap through a newer keyring package
before a Release is signed solely by a replacement key.

**Approved boundary:** modify `src/main.js`, `src/updater.js`, the release and
Shell-intake workflows, release-contract/coordinator helpers and tests,
`README.md`, `SECURITY.md`, `docs/RELEASING.md`, and this plan. Create a small
standard-library APT repository helper, its tests, and public packaging assets.
Do not add an npm dependency: Node's standard library handles deterministic
text, compression, and hashes; Debian's own `dpkg-deb`/APT tools handle Debian
package semantics; GnuPG handles OpenPGP signing and verification. Preserve the
Electron/daemon architecture, agent and credential ownership, the existing
AppImage/tar/Windows channels, and the immutable published `v0.2.0` release.
A new higher release activates APT; no published asset is replaced or appended.

- [x] **Step 10.1 — implement and locally prove the APT repository contract.**
  Build deterministic unsigned flat-repository metadata and the archive-keyring
  bootstrap package from injected public-key material; sign/verify with an
  ephemeral test key; exercise APT through an isolated local configuration and
  an HTTP redirect matching GitHub's latest-asset behavior; and make packaged
  Debian select an APT-owned, updater-disabled policy only when the bootstrap
  marker exists. Add focused falsification tests and faithful documentation.
  Create no real key, secret, release, repository setting, DNS record, package
  installation, or other external state.

  Completed 2026-08-26. `scripts/apt-repository.mjs` now builds the two-package
  flat index, compressed index, checksummed `Release`, clear and detached
  signatures, public-key/source assets, and root-owned archive-keyring package
  without an npm dependency. Its verifier rechecks the exact public
  fingerprint, both OpenPGP signatures, Release/index/package hashes, bootstrap
  package contents, source definition, and APT marker. The Linux integration
  test creates an ephemeral one-day key and minimal `.deb`, rejects package and
  index tampering, then proves a fresh isolated APT client can follow a
  latest-release-style redirect, authenticate the index, select the candidate,
  and download byte-identical package content. Desktop's real packaged-main
  probe proves only an observed Debian package plus the root-owned bootstrap
  marker disables the private updater; direct Debian, AppImage, tar, Windows,
  Store, and development policies remain pinned separately. `npm test`: 175
  passed, zero failed, one native-Windows-only skip. No external or privileged
  state was created.
- [x] **Step 10.2 — establish the real archive identity and wire both release
  writers.** Kyle creates one dedicated signing key in his own terminal without
  exposing it to chat; commit only its public key and fingerprint; store the
  private export separately in the existing `manual-release` and
  `automated-release` GitHub environments. Extend both native-build paths,
  provenance, exact asset contracts, recovery logic, and nonpublishing rehearsal
  so a release is published only with valid APT metadata signed by that exact
  key. No package dependency code runs beside the signing secret.

  **In progress 2026-08-26.** Kyle ran the dedicated key-creation helper
  successfully. The working tree now contains only its public RSA-3072 identity
  and canonical fingerprint
  `30C663842E3433E94B793B79AD4514FE0C3F6F0C`; independent public-key inspection
  confirms signing capability and expiry on 2029-08-26. The private identity
  remains in its dedicated user-owned GnuPG directory. Both GitHub environments
  currently report no stored secret names, so no private export has crossed
  that boundary yet.

  The pending implementation expands both workflows and the exact release
  contract from nine native files to 17 native/APT files. The signing jobs have
  read-only repository tokens, install no dependency code, erase their temporary
  GnuPG homes, and feed independent signature verification before provenance or
  publication. A manual dispatch now fails before dependency code unless it is
  canonical `main`; that nonpublishing path uses the live main-only
  `automated-release` environment, while real `v*` tags retain the live
  reviewer-protected `manual-release` boundary. A new encrypted-backup helper
  refuses repository destinations and overwrites, keeps plaintext inside pipes,
  verifies the recovered fingerprint, and cleans failed partial output. Its fake
  orchestration tests and a real disposable GnuPG overwrite/encryption probe
  pass. The complete local suite currently passes 182 tests, fails zero, and
  skips one native-Windows-only probe; both workflows parse as YAML, all changed
  shell/JavaScript files parse, and `git diff --check` is clean. At that
  checkpoint, the remaining gates were an off-machine encrypted recovery copy,
  both protected environment secrets, and a 17-file nonpublishing workflow run
  from the eventual canonical `main` commit.

  **Private-material boundary completed 2026-08-27.** Kyle confirmed the
  encrypted recovery file was created and copied off the working machine, with
  its passphrase retained separately. He then ran the check-only GitHub helper
  successfully and explicitly ran its mutating form. Independent read-only
  GitHub queries now report exactly one
  `MIRAFOLD_APT_SIGNING_PRIVATE_KEY` name in `manual-release` (updated
  2026-08-27T15:11:30Z) and one in `automated-release` (updated one second
  later); no value was read. The repository Actions variable list remains
  empty, so automated publication is still dormant. The sole remaining Step
  10.2 gate is the canonical-`main`, nonpublishing 17-file hosted rehearsal.

  **Completed 2026-08-27.** Feature PR #17 passed DCO plus native Linux and
  Windows CI and merged the reviewed APT implementation into `next`. Because
  squash history made an ancestry merge conflict despite equivalent prior
  content, `release/0.3.0` was reconstructed from `origin/main` plus the exact
  binary tree difference to `origin/next`; equality gates proved its staged
  product tree matched reviewed staging before the Desktop version bump. PR
  #18 passed DCO and both native CI jobs and merged as protected `main` commit
  `1e16d69955b251d8bbd8caccc54e394ef616ffde`. Canonical-main nonpublishing run
  `33104838996` then passed source verification, exact prepared-source tests,
  native Linux and Windows package smokes, production-key APT signing, all
  17-file checks, and provenance; its publisher was event-gated and skipped.
  Stable release `v0.3.0` was subsequently published with the complete 17
  assets. The archive identity, both writer contracts, and the manual
  publication path are therefore proven; live automated publication remains a
  later explicit opt-in.
- [ ] **Step 10.3 — publish and dogfood the real channel.** Through the normal
  `next` → release branch → protected `main` → signed-tag process and Kyle's
  explicit merge/publication approvals, publish a higher Desktop release. From
  a clean anonymous path on this Ubuntu machine, install the bootstrap package,
  refresh APT, run `sudo apt install mirafold-desktop`, launch the installed
  application, exercise both native modules, verify APT ownership and clean
  shutdown, and prove the website-ready installation instructions byte for
  byte. Website-repository edits and any announcement remain separately scoped;
  this Step supplies their exact tested copy and links.

  **In progress 2026-08-27.** Kyle installed the public archive-keyring package
  and `mirafold-desktop` through the real APT channel on Ubuntu, launched the
  installed application, and observed its bundled Mirafold `0.3.7`. That proves
  anonymous APT acquisition and launch of public Desktop `v0.3.0`; the native
  module exercise and final website-ready instruction check remain open. The
  stale Shell was expected release content, not an updater failure, and led to
  the Mirafold `0.5.0` candidate gate below.

  **Mirafold 0.5.0 pre-release gate — diagnosed and repaired 2026-08-27.** The
  exact reviewed candidate is Desktop `0.3.1` plus Mirafold `0.5.0`; its
  `package.json` SHA-256 is
  `0f58bff55bc1be320b8dafcc28585497865dcfbcce7a7f4a9cbfceba562656a2`
  and its `package-lock.json` SHA-256 is
  `5b5b4b1ff64d0e764a256bed1756a42b82ae973c3dd09f1e6488bcaaf9bde508`.
  The first proposed startup correction separated Windows wrapper preparation
  from the daemon URL phase but bounded both at 60 seconds. Twelve unchanged
  full CI runs at diagnostic commit
  `95359b5bb39b19ef8f6f152107a6c9a6f3f77fa2` produced 12/12 Linux passes and
  11/12 Windows passes. Run `33110421231` failed after 60.8 seconds with the
  phase-specific `the Windows daemon wrapper never became ready` error; the
  real package-smoke step was therefore skipped. Mirafold had not launched.
  The successful native ownership probes lasted 52.6–72.3 seconds. This proves
  the remaining boundary was PowerShell's runtime `Add-Type` compilation under
  runner load, not Mirafold `0.5.0` import or daemon startup.

  Final fix source commit `ee752b48b60a7438d71465ddda2fed0c20ba4645`,
  landed on `next` as `1d2aecfaff0267390ac2fbc549273228f3203165`,
  emits one constant credential-free readiness line after Job Object setup and
  stop-event registration, immediately before daemon launch. Windows wrapper
  preparation now has a bounded 120 seconds; receipt of that line starts a
  fresh 60-second daemon URL deadline. Linux retains its original single
  60-second URL deadline. The native smoke's outer guards were expanded only
  enough to let those inner bounds report their own failure.

  The exact candidate at diagnostic commit
  `f398e2df54143bd5e377c611943526f94fb2e6f8` passes the local 185-test suite
  (184 passed, zero failed, one native-Windows-only skip), `npm ls --all`, a
  zero-vulnerability npm audit, all 376 registry signatures, and 56
  attestations. Twelve further full CI runs passed on both platforms: Windows
  12/12 and Linux 12/12; native Windows ownership probes spanned 44.1–79.4
  seconds and every real package smoke passed. Batch-one run IDs are
  `33111480461`, `33111480498`, `33111480599`, `33111480638`, `33111480657`,
  and `33111480713`; batch-two IDs are `33111879563`, `33111879544`,
  `33111879542`, `33111879889`, `33111879691`, and `33111879266`. These were
  read-only manual CI dispatches. PR #19 subsequently passed DCO and both native
  CI jobs and merged only the startup correction into protected `next`; at that
  checkpoint the candidate manifests remained diagnostic and no Mirafold
  `0.5.0` release or asset had been created. Public production remained
  immutable `v0.3.0`.

  **Real update branch prepared 2026-08-27.** After the v0.3.0 production state
  was synchronized back into `next`, `npm run release:prepare -- 0.5.0` created
  Desktop `0.3.1` plus Mirafold `0.5.0` on `feature/mirafold-0.5.0`. The command
  independently rechecked npm `latest`, required npm `12.0.2`, regenerated the
  lock with lifecycle scripts disabled, limited churn to Mirafold's dependency
  closure, and produced the same two SHA-256 hashes recorded above. A clean
  lockfile install contains 376 packages; `npm ls --all` passes, npm reports
  zero vulnerabilities, all 376 registry signatures and 56 attestations verify,
  and the 185-test suite passes 184 with only its native-Windows-on-Linux skip.
  This branch creates no tag, release, or asset; public production remains
  `v0.3.0` until the separately approved release process completes.

### Phase 11 — persistent desktop interface scale

Started 2026-08-29 at Kyle's request. This is one normal-sized feature Phase;
its single Step is one independently executable pass. The outcome is familiar
browser-style whole-interface zoom in the Desktop window, including native
menu commands, keyboard shortcuts, and a device-persisted scale that survives
restarts and the daemon's changing loopback origin.

**Verified starting state (2026-08-29):** `src/main.js` already places
Electron's generic `resetZoom`, `zoomIn`, and `zoomOut` roles in the hidden
native View menu. No source symbol reads, validates, or persists an interface
scale; `src/state.js` stores only `lastFolder`. Every daemon boot reports a
fresh port and therefore a fresh origin. Electron documents its default zoom
policy as origin-scoped, so the existing role delegation does not establish
the device-level persistence this feature requires.

**Approved boundary:** modify `src/main.js`, `src/state.js`, their focused
tests, `README.md`, and this plan. Create one small pure interface-scale module
and its focused test. Add no package: this is small main-process and JSON-state
glue, while a dependency would add installed bytes, transitive code, and alert
surface without supplying protocol depth or security hardening. Preserve the
100% first-run default, window size, daemon and published Shell behavior,
renderer isolation, navigation and permission policy, project selection,
updaters, release machinery, package versions, and packaging. No deployment,
tag, release, or external state change belongs to this Phase.

- [x] **Step 11.1 — implement and prove persistent browser-style zoom.** Give
  the native View menu explicit Actual Size, Zoom In, and Zoom Out commands
  with the standard `CmdOrCtrl+0`, `CmdOrCtrl+Plus`, and `CmdOrCtrl+-`
  accelerators. Scale the whole Chromium page through the main process, clamp
  changes to deliberate browser-like levels from 50% through 300%, persist
  only validated values in Electron's per-user state, start the window at the
  remembered value without a 100% flash, and reapply that value after every
  completed navigation. Prove stepping, bounds, reset, invalid-state fallback,
  cross-field state preservation, menu wiring, navigation reapplication, and
  unchanged security settings; document the user controls and run focused plus
  complete tests.

  **Completed 2026-08-29.** New pure `src/interface-scale.js` owns the exact
  50%–300% browser-like levels, invalid-value fallback, bounded stepping, and
  cross-platform shortcut mapping. `src/main.js` replaces the generic
  origin-scoped roles with explicit native commands, accepts both Plus and the
  browser-compatible Equals-key alias, consumes each shortcut before the menu
  can duplicate it, supplies the saved factor as the page default, and reapplies
  it after every completed load. `src/state.js` validates the new number and
  preserves it alongside `lastFolder` in the existing per-user JSON file; no
  state moves into the project or renderer.

  Focused interface-scale/main-process verification passes 16/16. The complete
  suite passes 198 tests, fails zero, and skips only the existing
  native-Windows-on-Linux probe. An isolated real Electron 43.4.0 X11 probe
  observed 125% on the loaded page, menu-driven 150%, 150% reapplied after a
  cross-origin navigation, and Actual Size restoring 100%. `npm run pack`
  succeeds; the packaged module is byte-identical to source; and the packaged
  smoke loads both native modules, completes the authenticated daemon handshake,
  and proves process-tree shutdown. `node --check src/main.js` and
  `git diff --check` pass. README now gives the literal shortcuts and hidden-menu
  access. No dependency, package version, daemon/Shell behavior, security
  boundary, release setting, tag, deployment, or external state changed.

### Phase 12 — packaged Desktop render-MCP hotfix

Started 2026-09-01 from the hotfix specification in `HANDOFF.md`. The installed
Desktop 0.3.9 / Shell 0.8.1 artifact was reproduced before editing: its real
Gemini adapter generated `/opt/Mirafold/mirafold` plus the bundled
`dist-server/render-mcp.js` with no child environment, and the MCP connection
closed before initialize while Electron attempted graphical startup. A
one-variable control giving only that child `ELECTRON_RUN_AS_NODE=1`
initialized, listed exactly 18 tools, called `render_card` with a valid ID,
and closed cleanly. Both renderer and daemon trees were reaped.

**Boundary:** Shell owns the executable correction on an isolated branch and
Desktop remains a thin consumer of the exact published package. Desktop may
modify only `scripts/packaged-smoke.mjs`, its focused test, and this plan before
normal automated intake changes the two version manifests. Do not modify
Desktop runtime code, vendor Shell, weaken Codex's required MCP, or let
Electron Node mode enter the daemon, agent, command, or ordinary-child ambient
environment. This work remains separate from Shell's cleanup PR.

- [ ] **Step 12.1 — release and accept the packaged renderer correction.** Add
  a native-package regression that reaches the real bundled Shell adapter,
  reads its engine-native child environment, and runs real MCP
  initialize/list/call/close through the packaged Electron executable. It must
  prove the override contains only `ELECTRON_RUN_AS_NODE`, exactly 18 tools and
  `render_card` work, all ambient environments remain scrubbed, and renderer,
  agent, and daemon processes leave no orphan. Release the independently
  reviewed Shell patch, let automatic Desktop intake consume the exact public
  package and advance Desktop one patch, run Linux and Windows package gates,
  then install the public Desktop artifact and complete the real-engine and
  normal-package acceptance contract from `HANDOFF.md`.

  **Progress 2026-09-01:** Shell PR #91 is one signed-off hotfix commit over
  current Shell `next`; local Shell gates pass 1,117 unit, 161 integration, 130
  browser end-to-end, and 11 managed/visual tests. Desktop's regression is
  implemented on isolated branch `fix/packaged-render-mcp-smoke`; the full
  Desktop suite passes 201 active tests with only the native-Windows-on-Linux
  skip. A disposable Desktop package containing the local Shell tarball passes
  the complete existing package smoke plus real MCP proof, with only the one
  child key present and every cleanup/ambient assertion true. This disposable
  package is verification only and changed no Desktop dependency manifest.
  Remaining: approve and merge Shell PR #91, publish the Shell patch, consume
  its exact registry artifact through automated Desktop intake, land this
  regression against that pin, run native Windows CI, and complete installed
  public-artifact acceptance.

### Phase 13 — Linux Desktop owns Mirafold Pro securely

Opened 2026-09-04 at Kyle's express request. This phase supersedes only the
old statement that Desktop handles zero **Mirafold-owned Pro credentials**;
the separate provider-credential GUI remains parked. It is an oversized
feature phase: every numbered Step is one independently executable pass with
its own verification and dated plan update. `$next` works one Step and stops.

**Outcome and release gate.** A person who starts Mirafold from an app-center
icon on Linux clicks the existing Pair flow, completes purchase or connects an
existing Pro key in their normal browser, returns automatically, and gets a
working relay QR without opening a terminal or storing a key themselves. The
credential survives app restarts only when the operating system supplies a
real secret store. This installed Linux path must pass production end to end
before mirafold.com removes the demo's browser bar or mentions Desktop as a
use option. Windows remains behaviorally unchanged and unclaimed in this
phase; it has a separate proof phase below.

#### Verified starting state — 2026-09-04

- `src/main.js` creates one sandboxed BrowserWindow with context isolation,
  no Node integration, no preload, and no IPC. Its navigation guards hand all
  ordinary HTTP(S) links to the system browser. There is no activation
  controller, loopback callback listener, credential menu, or `safeStorage`
  import.
- `src/daemon.js` obtains a login-shell environment, starts the exact bundled
  `mirafold` daemon with `stdio: ["ignore", "pipe", "pipe"]`, and copies the
  environment into the child. It has no private secret input channel.
  `src/daemon-bootstrap.cjs` removes Desktop's PID-ledger and Electron Node-mode
  variables before importing Shell, but reads no credential.
- `src/state.js` persists only project folder and interface scale as ordinary
  JSON in Electron's per-user data directory. No source file stores a Pro key.
- The pinned Electron 43.4.0 type surface contains asynchronous
  `safeStorage.encryptStringAsync`, `decryptStringAsync`, and
  `isAsyncEncryptionAvailable`. Electron documents that Linux may fall back to
  `basic_text`, where the encrypted value is protected by a hard-coded
  plaintext password; that backend is not acceptable for a Pro key. Source:
  [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
- Shell's Pair card links to `https://mirafold.com/pay`; the current generic
  navigation path opens it externally. The app already holds a single-instance
  lock, so a second process cannot become a competing activation receiver.

#### Approved implementation boundary

Phase 13 may create `src/pro-store.js`, `src/pro-activation.js`,
`test/pro-store.test.js`, and `test/pro-activation.test.js`. It may modify
`src/main.js`, `src/daemon.js`, `src/daemon-bootstrap.cjs`, `src/navigation.js`,
`src/app-lifecycle.js`, `package.json`, and `package-lock.json`, plus their
directly corresponding tests, package probes, and release evidence. Manifest
changes are limited to pinning the exact published Shell version; no package is
added. The runtime creates one versioned ciphertext file below Electron
`userData`, not a project file or repository artifact.

`src/state.js`, the sandboxed renderer configuration, the absence of preload
and IPC, generic external navigation, project-folder data, updater trust and
release policy, ordinary no-key startup, and all Windows launch code—including
`src/windows-daemon-job.ps1`—stay behaviorally unchanged in Phase 13. Phase 14
is the only authority to change Windows credential carriage. Any need for
another executable file, renderer bridge, package, stored file, platform, or
service stops the Step for an explicit boundary amendment before the change.

#### Locked design and threat boundary

Use the system browser plus an IPv4-loopback callback and RFC 7636 S256 PKCE,
the standard native-application pattern in
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html) and
[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html). Electron main creates
a 32-byte verifier, 32-byte state, and random callback-path nonce; derives the
S256 challenge; binds an ephemeral listener to literal `127.0.0.1` **before**
opening the browser; durably encrypts the exact pending flow before launch; and
sends only version, port, state, callback nonce, and challenge to the site. The
verifier is plaintext only inside Electron main and the final HTTPS request;
its expiring at-rest copy is protected by the same accepted safeStorage backend
as the key. It never uses `localhost`, a LAN/wildcard bind, a custom URL scheme,
or an embedded Electron login window.

The listener accepts one bounded GET on the exact random path with the exact
state, returns a constant local success page, and closes on success or a short
deadline. A callback code alone cannot redeem: Electron main posts it with the
main-process-only plaintext verifier over HTTPS, and the site's D1 conditional
redemption lets one caller win. On restart, Desktop may resume only the exact
unexpired stored port/path/state/challenge/verifier and must re-bind that port;
the still-open or history-reopened browser welcome can then retry. Desktop
cannot reconstruct a Paddle transaction if that browser context is also gone,
and it never rebinds a completed transaction to fresh parameters. Wrong paths,
methods, hosts, state, duplicate callbacks, early browser close, timeout, and
app shutdown all fail without affecting local Mirafold. Never echo the code or
state into the local HTML or a diagnostic.

On Linux, initialize asynchronous `safeStorage` before opening purchase UI.
If encryption is unavailable, temporarily unavailable, reports `basic_text`,
or cannot complete an encrypt/decrypt probe, stop **before checkout** and say
that a supported system secret service is required. Never call
`setUsePlainTextEncryption`. Store only safeStorage ciphertext in a dedicated
versioned secret-state file under Electron `userData`, created through an
owner-only, no-follow, atomic replace; never mix it into `state.json`. The
envelope may hold the current permanent key, at most one bounded pending
activation record, or both during renewal; it never holds arbitrary site data.
The pending record expires no later than the existing 48-hour transaction-claim
window. Validate every decrypted field, support safeStorage's re-encryption
signal, erase only expired pending state while preserving a current key, and
make a corrupt/tampered/unavailable record a generic recoverable activation
error—not a log of bytes or an app-start failure.

After activation, keep the key plaintext only in Electron main memory, encrypt
and durably replace the old credential while clearing the pending field first,
then restart the daemon. A failed exchange or store preserves the prior
credential plus any still-valid encrypted pending flow so the same committed
transaction can retry; a success or expiry removes only the pending field.
When a stored credential exists, remove any ambient `MIRAFOLD_LICENSE_KEY` from
the child environment before spawn and pass only the stored key to the exact
compatible Shell over a pipe connected to standard input, with one fixed non-
secret internal flag in argv. With no stored credential, preserve today's
legacy environment behavior. Close the parent pipe immediately; Shell consumes
and closes its end before sessions can start. The key must never
enter Desktop or daemon environment variables, command arguments, renderer or
preload state, IPC, a WireMsg, browser storage/DOM/clipboard, project files,
stdout/stderr, system journal, updater metadata, crash dialogs, or agent child
processes. The existing renderer isolation stays absolute: native activation,
storage, exchange, restart, and removal all live in main-process modules.

Only an exact Shell-owned Desktop Pro URL from the current daemon origin starts
activation. Other HTTP(S) navigation remains the user's ordinary browser;
other schemes remain blocked. Agent-authored content can mimic a link, so the
native controller must treat link activation as an untrusted request: it may
open the browser after explicit user navigation, but it exposes no credential,
does not accept site-supplied arbitrary callback URLs, and cannot overwrite the
stored key until the complete state/PKCE/site validation succeeds.

The first accountless release has an honest recovery limit: a new Desktop buyer
does not need to see or save the key, but a lost machine or deleted credential
cannot silently authorize a second installation. An existing subscriber may
use the site's deliberate existing-key field; a new buyer without that key
uses support after device loss. Do not disguise this as account recovery, and
do not add accounts, email magic links, key export to clipboard, hardware
attestation, certificate pinning, or a device-token service inside this phase.
A confirmed user need for self-serve multi-device recovery is the trigger for
a separate design. The same support boundary applies when both an encrypted
pending activation and its browser transaction context are lost after payment.

An existing subscriber's already-held key is handled differently from a new
purchase: it passes transiently through the site's dedicated, first-party-only
`/activate` password form and no-store request. That page loads no Paddle or
other third-party resource and never puts the key in a URL, storage, clipboard,
redirect, or response. A browser extension can still read a key the user types;
the new-purchase path never exposes one to the browser at all.

**Residual authority:** root/administrator, malware already executing as the
same desktop user, a compromised OS secret service, compromised Mirafold/site/
Paddle code, or a substituted installer can still obtain or use the key. The
feature protects at-rest bytes from other users and ordinary file disclosure,
removes the key from ambient process metadata and renderer/agent surfaces, and
blocks callback interception/replay; it does not claim endpoint compromise is
solvable from inside that endpoint. OS crash dumps, swap, and hibernation remain
within the operating-system security boundary. Electron and Shell necessarily
handle JavaScript strings, which cannot be reliably zeroized; references and
lifetimes are minimized, but heap remnants remain part of that same endpoint
boundary.

No dependency is added. Electron's built-in safeStorage, Node HTTP/crypto/fs,
and the site's existing Web APIs cover the protocol. A package would add
installed bytes, transitive code, and advisory surface without supplying a
security primitive the platform does not already provide.

- [x] **Step 13.1 — build the fail-closed encrypted secret-state store.** Create
  a small injected main-process module for asynchronous safeStorage readiness,
  backend policy, exact credential/pending-flow schemas, expiry, ciphertext
  load/decrypt/re-encrypt, and owner-only atomic replacement/removal. Use a
  dedicated versioned secret path; reject symlinks, non-regular files,
  oversized blobs, `basic_text`, temporary unavailability, corrupt ciphertext,
  and malformed plaintext without logging supplied bytes. Do not make ordinary
  app startup depend on Pro storage. Done when focused tests exercise each
  provider/result/error, key-only, pending-only, and renewal-combined records,
  the 48-hour pending ceiling and expiry that preserves an existing key,
  permission and atomicity behavior; interrupted writes preserve the prior
  record; removal is confirmation-ready and idempotent; mutations of the basic-
  text refusal/no-follow/mode/size/expiry checks fail; and the complete Desktop
  suite plus `npm ls --all` and audit remain green with no dependency change.

  **Completed 2026-09-06.** `src/pro-store.js` is an injected, Linux-only main-
  process store that accepts only Electron 43.4.0's four named secret-service
  backends, completes an asynchronous encrypt/decrypt probe, rechecks the
  backend before committing bytes, and requires the pinned secure-provider
  ciphertext tags (`v11` Secret Service/KWallet or `v12` Secret Portal).
  Electron's `v10` Posix fallback uses a public hard-coded key and is refused
  even when the configured backend still has a trusted name. The exact
  version-1 envelope supports key-
  only, pending-only, and renewal records; validates the deployed license-key
  shape plus every 256-bit callback/PKCE field and the verifier's S256
  challenge; caps pending state at 48 hours; and removes expired pending state
  without removing a current key. Ciphertext lives only at owner-owned mode
  `0600` below an owner-owned mode `0700` directory, with no-follow opens,
  bounded reads, same-directory exclusive temporary files, file and directory
  synchronization (including the `userData` parent before every write),
  atomic rename, crash-orphan reconciliation, safe rotation rewrites, inspected
  removal, and idempotent absence. A failure after rename or unlink returns the
  distinct `durability-uncertain` result so the caller must inspect or load the
  visible state before retrying. The module has no startup import, Electron
  import, renderer bridge, dependency, or logging path.
  `test/pro-store.test.js` adds 19 focused tests. Twelve product-code mutations—
  allowing `basic_text`, accepting the `v10` fallback tag, re-decrypting rotated
  ciphertext instead of using its first successful result, removing no-follow,
  weakening mode validation, allowing the first oversized byte, changing
  exact-boundary expiry, skipping the required parent-sync retry, ignoring the
  reserved temporary namespace, and collapsing post-commit uncertainty into an
  ordinary write error, plus hiding a failed pre-rename cleanup behind that
  ordinary error and letting a recovery read skip the confirming directory
  sync—failed their focused test before the original bytes were restored. Final
  evidence: focused 19/19; complete suite 230 tests with 229
  passing and the one existing platform skip; syntax checks,
  `npm ls --all`, and `npm audit` green with zero vulnerabilities; `package.json`
  and `package-lock.json` unchanged.

- [ ] **Step 13.2 — build and attack the browser/loopback PKCE client in
  isolation.** Create pure activation-request and controller modules with
  injected clock, randomness, browser opener, fetch, and HTTP server. Generate
  256-bit verifier/state/path entropy, S256 only, canonical site parameters,
  literal-loopback ephemeral binding before open, persist and read back the
  encrypted pending flow before browser launch, an exact method/Host/path/state
  gate, bounded headers/query/body/response reads, one active flow, one
  exchange, exact-flow restart resumption, and deterministic expiry/shutdown
  cleanup. Accept only the exact HTTPS production activation origin and a test-
  injected loopback origin; never follow an exchange redirect or trust a
  callback URL supplied by the site.
  Done when interception, replay, wrong-state/path/host/method, port pre-bind,
  oversized/malformed JSON, non-HTTPS production, redirect, timeout, duplicate
  click, crash/restart with the original port free or occupied, expired pending
  state, and shutdown tests all fail closed while the happy path returns one
  in-memory key; seeded code/verifier/state values are absent from every log and
  local success page; mutations prove PKCE/state/path/TLS/deadline/durable-
  pending checks bite.

- [ ] **Step 13.3 — carry the stored key to the published Shell over a private
  pipe.** Pin the Shell version that contains Phase DA's reviewed stdin contract.
  Extend only the Linux daemon launch spec and bootstrap argument pass-through:
  a launch with a decrypted key gets piped stdin plus the fixed internal flags;
  it also removes an ambient `MIRAFOLD_LICENSE_KEY` from `daemonEnv` before
  spawn. An unactivated launch keeps today's environment, ignored stdin, and
  argv. Write once, end, drop the main-process plaintext reference as soon as
  the child owns its copy, and make write/early-exit failure retire the entire
  daemon tree before any replacement. Never put the stored key in `daemonEnv`,
  PowerShell, ledger files, or launch diagnostics. Done when unit and real-child
  probes inspect `/proc` environment/cmdline, inherited descriptors, daemon/
  agent output, and cleanup;
  neither the stored nor a seeded stale ambient key appears, the daemon gets Pro
  entitlement and billing state, no-key legacy startup is unchanged, and
  package tests prove the exact published Shell—not a vendored/local substitute—
  is used.

- [ ] **Step 13.4 — integrate activation and restart into the native
  lifecycle.** Recognize only the fixed Desktop marker on an external URL from
  the current trusted daemon main frame; preflight secure storage; run one
  activation at a time; open the fully parameterized site URL in the system
  browser; store before success; then use the existing serialized stop/boot
  ownership path to restart in the same folder and surface the relay QR. Add
  native, non-secret progress/failure/success messages. Resume an unexpired
  pending flow after app restart and leave a failed post-purchase store
  retryable only through that exact flow. Done when the main-process probe
  proves the URL provenance, preflight-before-browser ordering, pending-state
  durability, store-before-restart ordering, success/failure UI, and crashes
  before callback, after exchange, and after durable key replacement; generic
  navigation/permissions remain unchanged, no renderer bridge exists, and the
  complete Desktop suite passes.

- [ ] **Step 13.5 — close removal and competing-lifecycle races.** Add a
  neutral native menu item to remove Pro access from this device behind a
  confirmation that states the accountless recovery consequence. Removal must
  first cancel any pending activation and close its listener, cleanly stop the
  daemon, delete only the encrypted Pro state, and restart unentitled in the
  same folder; canceling removal changes nothing. Serialize app quit, folder
  change, updater install, daemon crash, duplicate activation click, callback,
  exchange completion, credential removal, and restart so each race has one
  owner, one terminal state, no stale listener, and at most one dialog. Done
  when focused model and real main-process probes cover every pairwise ordering,
  key/pending files survive only the intended outcomes, no daemon or pipe is
  orphaned, and the complete Desktop suite passes.

- [ ] **Step 13.6 — prove the real Linux packages and secret-store boundary.**
  Build `.deb`, AppImage, and tar candidates outside the checkout and inspect
  their exact bundled Shell, native modules, flags, file modes, and absence of
  plaintext fixtures. Launch from the installed desktop entry—not a terminal—
  against a real supported Secret Service and complete a local fake-site/
  fake-billing/gated-relay activation, restart, subscription-status call,
  remote encrypted pairing, remove, and unentitled restart. Force
  `--password-store=basic`, unavailable/locked keyring, corrupt/symlinked store,
  and system-journal inspection. Kill and reopen the app before callback, after
  exchange, and before/after credential replacement; resume only the exact
  pending request. Exercise ordinary quit and package cleanup for every form.
  Done when each real artifact has evidence for encrypted persistence, crash
  recovery, restart, removal, private daemon input, exact published Shell,
  native-module load, and zero remaining daemon/agent/listener or plaintext
  credential; record artifact paths/hashes and observations without publishing.

- [ ] **Step 13.7 — run the feature-delta correctness hunt.** Review the exact
  Phase 13 product delta and adjacent startup, update, folder, and daemon
  ownership logic for concrete incorrect behavior. Diagnose and reproduce each
  finding before editing, make the narrow fix and a class-level regression test,
  fix no more than ten confirmed findings, run the focused loop then the full
  gates, and end with the required fresh-agent cold review. If more than ten
  fixes are required, insert a continuation Step before 13.8. Done when every
  confirmed correctness finding is fixed, no speculative hardening is mixed
  into this pass, and the package smoke still proves all three Linux forms. Do
  not publish or freeze hashes.

- [ ] **Step 13.8 — run the feature-delta security audit.** Attack the exact
  fixed candidate for callback theft, wrong state/path/host, concurrent
  callback, exchange replay, parameter substitution, hostile renderer links,
  ciphertext/symlink replacement, pipe and descriptor inheritance, process
  metadata, browser/Paddle separation, billing-key authority, crash dumps/logs/
  journal, stale pending flows, and quit/folder/update races. Prove each finding
  before editing, turn it into a regression test, fix no more than ten confirmed
  findings, and end with the required fresh-agent cold review; insert a
  continuation Step before 13.9 if the cap is exceeded. Done when no confirmed
  in-scope security finding remains and all focused, full, native, audit, and
  packaging gates pass. Do not publish or freeze hashes.

- [ ] **Step 13.9 — falsify the Phase 13 test suite.** Run the repository's
  test-audit procedure against every claimed protection and lifecycle outcome,
  using mutations in product code—not comments or the proof itself—to establish
  which tests really fail. Repair every evidence-backed missing or wrong-target
  test, keep each hunter as a permanent regression, rerun three unchanged full
  suites to characterize flakes, and finish with the required fresh-agent cold
  review. Done when every named Phase 13 contract has load-bearing evidence,
  test theater is removed, no product behavior was changed in this pass, and
  all local/native/package gates are green.

- [ ] **Step 13.10 — freeze one release candidate without changing it.** From
  the exact commit that cleared Steps 13.7–13.9, run the full clean-room release
  rehearsal and native CI, build `.deb`, AppImage, and tar exactly once, inspect
  their contents and secret-free metadata, and record immutable hashes. Any
  source, test, dependency, workflow, or package-content change invalidates the
  candidate and returns work to the owning review Step; it is not folded into
  this pass. Done when one unchanged set of bytes has all required green run
  IDs, attestable inputs, package manifests, and hashes. Do not deploy or
  publish.

- [ ] **Step 13.11 — accept the frozen candidate against production.** Require
  the reviewed site activation endpoints and D1 migration live first. Install
  Step 13.10's exact bytes through a candidate APT source on a clean supported
  Linux desktop and launch from the app center. First activate with an existing
  real Pro key to prove the no-charge path; Kyle types it in his own system
  browser, never pastes it into chat, and the assistant never reads it. Then,
  only with Kyle's explicit authorization in that future turn, run one fresh
  live monthly Paddle trial: it charges $0 immediately but becomes a recurring
  $12/month charge after
  seven days unless canceled; cancel it during the same acceptance pass after
  proving activation so no charge is expected. Prove browser return, hidden
  key, entitlement exchange, QR, phone session, app restart, machine restart,
  subscription management, removal, and reconnect/support fallback. Record
  only redacted production request/result evidence and confirm ordinary npm/
  browser checkout is unchanged. Done when the frozen hashes—not a rebuilt
  approximation—pass the full installed arc. Do not publish or edit
  mirafold.com in this Step.

- [ ] **Step 13.12 — publish exactly the accepted Linux release.** Reconfirm the
  candidate hashes equal Step 13.11, then use the protected Desktop release path
  without source changes. Verify the tag, release manifests, attestations,
  anonymous assets, APT index/signature, and installed version; update one
  existing APT installation through the real channel and repeat activation
  persistence plus relay pairing after update. Record versions, commits, run
  IDs, artifacts, hashes, and observations. Only this completed Step unlocks
  the site's public-positioning phase; it does not itself edit mirafold.com.

### Phase 14 — Windows Desktop Pro activation proof (deferred; not a Linux gate)

Windows may not inherit the Linux result by analogy. Its current PowerShell Job
Object wrapper passes only standard handles to the daemon, Electron safeStorage
uses DPAPI with same-user rather than app-isolated semantics, and no
maintainer-owned human Windows test machine has been established. Do not start
this phase through `$next`; Kyle must expressly open it.

- [ ] **Step 14.1 — carry the private pipe through the real Windows wrapper.**
  Extend and prove handle inheritance without weakening kill-on-close ownership
  or leaking plaintext into PowerShell command lines, environment, transcripts,
  event names, or diagnostics. Run native runner attacks and inspect the packed
  process tree.
- [ ] **Step 14.2 — prove DPAPI storage and the full installed flow on ordinary
  Windows.** Exercise another-user refusal, same-user residual behavior,
  installer/update survival, uninstall residue, browser callback, ConPTY
  children, SmartScreen/wizard behavior, restart, removal, and no orphans on a
  real human desktop. Only a green result can justify “Windows preview” Pro
  language; until then Windows users are not told Desktop Pro works.

### Audit and test-audit pass — 2026-08-14

Completed 2026-08-14, on this same branch. A full security audit found one
unplanned gap: the manual tag `Release` workflow's build job was the only
dependency install in the repository still running npm lifecycle scripts,
without the pinned npm toolchain or the signature/advisory gates. Its build
jobs now mirror the Shell-intake install exactly — script-free, pinned npm
`12.0.2`, empty user config, `npm ls`/audit/signature gates, no setup-node
cache — pinned by a new workflow test, so the manual tag path and the
automated path package identical registry-verified bytes. Everything else
audited clean (git history, lockfile, workflows, scripts, redaction, resource
bounds), and the documented deliberate decisions were left alone.

A test-suite falsification audit (fifteen product-code mutations, eleven
caught) then proved four real gaps and repaired all of them:

- `npm run release:rehearse` accepted `# pass 1` as scenario proof, but Node
  counts the test FILE itself as one passing test, so a name pattern matching
  nothing still reported a pass — every rehearsal scenario stayed green with
  its evidence test renamed or deleted. The harness now also requires Node's
  named `ok N - <test>` TAP line, and a negative test pins the fix; a renamed
  evidence test now fails the rehearsal loudly with exit 1.
- Deleting the release contract's metadata-SHA-512-versus-payload check left
  the entire suite green: every prior tamper fixture also changed the
  payload's size, masking the hash guard. A same-size payload substitution
  and a corrupted-metadata-digest case now pin the only check that can refuse
  those bytes before the SHA-256 manifests exist.
- Deleting any of the window's three security-wiring registrations — the
  `will-redirect` guard, the `installPermissionGuards` call, or the
  window-open deny — left all tests green; the rules were unit-tested but
  nothing proved the real window consults them. The main-process probe now
  exercises navigation/redirect events, popups, and permission installation.
- The recorded v0.1.1 stacked-crash-dialog fix had lost its regression pin
  (no probe made a page load fail). A third probe mode drives the exact
  ordering — load rejects first, crash callback lands after — and requires
  exactly one dialog.

Also repaired: the bootstrap test now derives its expected Electron version
from the locked `electron` package instead of a hardcoded string (exactness
kept, upgrade churn removed), and the real `electron-updater` `AppUpdater`
export the tar strategy constructs is pinned so a reshaped dependency fails
in CI instead of silently on user machines. The suite grew 160 → **165**,
still ~2.5 s, three consecutive clean runs; all ten rehearsal scenarios pass;
`README.md` was updated to match. The plan itself was pruned the same day:
completed Phases 3–5, 8–9, the maintenance pass, and the Phase 1–2 status
narratives moved verbatim into `PLAN-ARCHIVE.md`.

**Post-push correction, same day:** opening PR #1 revealed that GitHub had
been rejecting `ci.yml` and `shell-intake.yml` at run creation on **every**
push since they were written — `${{ runner.temp }}` inside JOB-level `env:`
is not an available context there (`Unrecognized named-value: 'runner'`,
0-second failures with no jobs), and the audit fix had copied the same idiom
into `release.yml`, breaking the one workflow that had actually executed.
The flaw stayed latent because neither broken workflow had ever been
triggered for real: CI's push/PR filters target `main`, and scheduled or
dispatched workflows run only from the default branch — exactly the "GitHub
has not yet observed the new CI check identities" limit Steps 5.4/5.5
recorded. All five job-level uses across the three workflows now create and
export the isolated npm user config inside the toolchain step (`$RUNNER_TEMP`
plus `$GITHUB_ENV`), a cross-workflow test forbids the runner context in
job-level env (falsified: reintroducing the line fails it), and the presence
pins moved to the new idiom. Suite **166/166**. Lesson recorded: local YAML
parsing and text-pinning tests cannot validate GitHub's expression rules —
only a real triggered run can, and a workflow that has never fired is
unverified no matter how green the repo looks.

That first real CI run then paid for itself immediately: Linux passed, and
Windows failed on the Phase 9 crash-ownership probe's **first-ever native
execution** — the packaged-smoke child keyed on the bare platform, so the
minimal fixture app (fake daemon module, fake node-pty, no bootstrap or Job
wrapper) was asked to prove Job-Object crash ownership it cannot support.
The proof now applies exactly where its true-report requirement already
applied — the real `Mirafold.exe` — via an explicit
`MIRAFOLD_PROBE_CRASH_OWNERSHIP` flag the outer probe computes and the
mocked Windows test pins; the fixture lifecycle test expects `null` on every
host. Real-package behavior is unchanged, and the probe's first native
result still belongs to the next non-publishing dispatch run.

## Status

**Phase 1 — the app itself: DONE (2026-08-02)** — Electron shell, daemon
lifecycle, crash recovery, menu, Linux packaging, verified end to end in both
dev-checkout and packaged builds, including both native modules and clean
orphan-free quit → details archived in PLAN-ARCHIVE.md.

**Phase 2 — release: DONE. `v0.1.1` is the current public release
(2026-08-03)** — four installers on GitHub Releases, anonymous download
verified. `v0.1.0` is superseded and must not be handed to anyone. The v0.1.1
bughunt/audit fixes and the birth of the test suite → archived in
PLAN-ARCHIVE.md.

**Not announced anywhere, and nothing goes on mirafold.com** (Kyle,
2026-08-02) until it has been tested. The repo is public and therefore
indexable, but nothing links to it.

*Pre-release state (rehearsal run, Windows-payload inspection, the
hold-the-tag decision — since superseded by the v0.1.0 release above) →
archived in PLAN-ARCHIVE.md.*

## Decided, don't re-open

| decision | why |
| --- | --- |
| Daemon is a **child process**, not imported | crash isolation, event-loop isolation, per-folder cwd (`src/daemon.js` header) |
| **No preload / IPC / nodeIntegration** | keeps Mirafold's browser security model true as written |
| **asar off** | a partially-unpacked archive resolves the daemon but not its dependencies; the failure would surface only when packaged, on Windows, where it can't be debugged |
| **Linux + Windows direct targets remain unsigned** | Linux packages and the Windows NSIS installer are the existing direct targets. Windows may show a reputation warning or block under device policy; the separate planned Store package would receive Store signing. |
| **No macOS target** | no Mac artifact, packaging path, signing identity, notarization, or real-package proof exists. Apple documents a manual unidentified-developer override, but a normal supported direct release requires Developer ID signing, notarization, packaging, and real-Mac validation. |
| `.deb` + `.tar.gz` + `.AppImage` | AppImage alone is not enough: this target needs FUSE 2, and its missing-library failure was reproduced locally. The tar archive is the no-FUSE fallback. |
| **Linux updater follows installed form** | AppImage can replace its user-owned file; Debian requests system authorization through the available elevation helper; a tar extraction has no safe universal self-replacement path and therefore receives a notice plus the fixed official download URL |
| **npm**, not yarn | electron-builder assumes npm layouts; yarn 1 hoisting fights platform-specific optional deps, which is exactly how the native modules ship |
| **Repo stays public** (considered private 2026-08-05, rejected) | a shipped Electron app is trivially unpacked, so repo privacy protects nothing; no credential can ever live client-side; any paid gating is server-side (accounts plus a flat subscription with a capped usage allowance), so private had no benefit left |

## Facts about the world that no repo can observe

- **Kyle has a Mac** (stated 2026-08-02). This makes a future macOS release
  testable on real hardware if the project later takes on Apple Developer
  membership, Developer ID signing, notarization, and packaging. The test must
  include the launched-from-Finder `PATH` behavior that `src/login-env.js`
  exists to handle.
- **No maintainer-owned Windows machine has been established.** The current
  package has now been installed, launched, smoke-tested, and uninstalled on a
  hosted Windows runner. SmartScreen, the visible wizard, the folder picker,
  a real agent, ConPTY, file watching, and human update/restart behavior still
  require the tester protocol on an ordinary Windows machine.
- **macOS is deferred until Mirafold "takes off"** (Kyle's words, 2026-08-02) —
  a revenue trigger, not a technical blocker.

## Launch plan — decided 2026-08-17 (Kyle)

**Linux is the public launch; Windows ships alongside it labelled beta; macOS
is stated as not available.** The paid metered tier is **deferred to after
the Desktop launch** — this reverses the 2026-08-05 sequencing that made it a
pre-launch gate. It is cleanly separable: the tier is accounts + subscription
built upstream and on the site, and when it ships Shell intake carries it into
a new Desktop release that installed apps pick up themselves. Until then the
launch audience is people who already have a local Codex/ChatGPT login or an
API key in their environment, which is stated plainly in the README and the
release notes. Launch copy must also carry the two Linux caveats: `.deb`
first, AppImage needs FUSE 2, `.tar.gz` is the no-FUSE fallback.

The **held `mirafold` commit `6d31c39` is already on that repo's `origin/main`**
(verified 2026-08-17: contained by `origin/main` and 18 other remote
branches) — the old "push it at announcement time" item is closed; nothing is
held there anymore.

The repository now follows the Shell repository's branch/release process
(`docs/RELEASING.md`, adopted 2026-08-17): `main` is the production mirror,
`next` is staging, every commit is DCO-signed, manual Desktop releases go
`release/x.y.z` → PR into `main` → signed tag by Kyle, and automated Shell
intake keeps its direct, ruleset-bypassing push. Two rulesets
(`main-release-safety`, `next-staging-safety`) plus the `DCO` required check
are in `.github/repository-hardening.json` and applied by
`scripts/repository-hardening.mjs`.

## Next

1. **Land the 2026-08-17 launch-readiness branch through the new process** —
   PR into `next`, Kyle approves the merge, then it becomes the base of the
   bridge release below. Kyle's one-time GitHub actions (each is a click, none
   is code):
   - Add this repository to the org's **DCO** GitHub App installation
     (org Settings → GitHub Apps → DCO → Configure → Repository access → add
     `mirafold-desktop`), so the `DCO` check runs here.
   - Run `node scripts/repository-hardening.mjs audit`, then
     `node scripts/repository-hardening.mjs apply --confirm mirafold/mirafold-desktop`
     from a shell where `gh` is logged in as the repo admin. It refuses to
     activate until `main` has green `test (linux)`, `test (windows)` and
     `DCO` checks — so it runs after the first PR-driven merge to `main`.
2. **Complete `WINDOWS-TESTING.md` with a human** on the bridge candidate.
   Windows ships as beta either way; a green human pass upgrades the label
   later, a red one produces fixes through the normal flow.
3. **The bridge release** — first updater-capable Desktop version, via
   `docs/RELEASING.md` Path B (`release/x.y.z` from `next`, signed tag on
   `main`, Kyle approves the `manual-release` environment). Suggested version
   `0.2.0`: the updater is a new capability.
4. **Enable automation**: set the repository variable
   `MIRAFOLD_AUTOMATED_RELEASES` to `enabled` (Settings → Secrets and
   variables → Actions → Variables). From then on Shell releases become
   Desktop releases with no routine work.
5. **Download page on mirafold.com** (site repo, not here) with the Linux
   caveats, Windows-beta and no-macOS statements, and the credential
   requirement, then **announce**. Requires Kyle's explicit go.

## Known gaps, not yet scheduled

- **One process-timing test flaked once in seven full-suite runs (2026-08-17):**
  `retained Linux identities clean up a separate-session descendant after its
  leader crashes` (`test/daemon.test.js`) failed once under the full parallel
  suite and passed 6/6 full runs and 3/3 file-only runs afterwards. Not
  chased: nothing in that pass touched the code under test. If it recurs,
  characterize the rate before changing anything.

- **Credential entry has no Desktop GUI — PARKED (Kyle, 2026-08-03), not
  scheduled.** Provider policy belongs to the exact bundled Shell and must not
  be summarized as “every existing login works.” Shell `0.3.7` accepts a local
  Codex/ChatGPT subscription login; Claude Code and Gemini subscription logins
  alone are deliberately blocked for this third-party application path, while
  their API-key paths require the key to already be available in the user's
  normal environment. The Desktop neither creates nor stores provider
  credentials. **Reasons this remains upstream:** (1) a settings screen is
  product UI, storage, and daemon-environment behavior, so it belongs in
  `mirafold`; (2) accepting a credential means owning its storage, encryption,
  log/crash-report leakage, and uninstall behavior, while this repo currently
  handles **zero** credentials; (3) zero users have supplied evidence that the
  missing GUI blocks them. **Trigger to revisit is evidence, not a date:** a
  tester stalling on credential setup, or the marketing site targeting people
  who have only an API key.
- **Updater bridge and Shell-version boundary.** The public `v0.1.1` artifacts
  have no updater runtime or feed metadata, so those users still need one manual
  download of the first updater-capable release. Step 4.4 now proves the entire
  bridge and forward-only recovery sequence locally; creating that first public
  bridge still belongs to the gated release flow. Every Desktop package
  continues to carry the exact Mirafold Shell version selected by its committed
  lockfile and never installs Shell from npm
  on an end user's machine. Steps 5.1–5.3 own automatic Shell intake and the new
  Desktop release it triggers. AppImage and Debian direct paths, plus the tar
  notice path, are now locally proven; production-feed transitions, native
  Windows behavior, and the real Debian authorization dialog remain explicitly
  unclaimed. While releases remain unsigned, direct-update integrity rests on
  HTTPS and the release metadata's verified SHA-512 rather than publisher code
  signing.
- **One window at a time.** The architecture makes multi-window nearly free (a
  second `spawn` with a different `cwd`), but it needs window/daemon bookkeeping
  that v1 skips.
- **The Linux app-menu tooltip is too long.** The generated `mirafold.desktop`
  takes its `Comment` from `linux.description` (the long text the `.deb` needs)
  rather than the short `synopsis`. electron-builder computes that key after
  merging `desktop.entry`, so setting `Comment` there doesn't win — `Keywords`
  and `Name` do apply, `Comment` and `Categories` don't. Cosmetic only; the
  entry, icon and `StartupWMClass` are all correct.
- **The prior Windows orderly teardown is runner-proven; the Job crash path is
  not yet.** The superseded installed-candidate smoke exercised Windows
  `taskkill /T /F` and observed zero remaining `Mirafold.exe` images. The
  current packaged probe additionally exercises real ConPTY and forced daemon
  crash inside the new Job Object, but needs a fresh native Windows run. A
  person's ordinary window close and Task Manager observation remain part of
  `WINDOWS-TESTING.md` after that fresh artifact exists.
- **A hard kill of the GUI app can orphan the daemon.** On Unix, the daemon is
  detached so its process group can be signalled; on Windows, the Job handle is
  deliberately owned by the child wrapper that must survive the GUI. Both
  architectures therefore survive an uncatchable kill of Electron's main
  process. Normal quit and window close are handled; daemon-crash cleanup is
  locally proved on Linux, while the Windows Job path awaits its native run.
