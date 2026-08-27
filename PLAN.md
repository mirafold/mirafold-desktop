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
  CI jobs and merged only the startup correction into protected `next`; the
  candidate manifests remain diagnostic and no Mirafold `0.5.0` release or
  asset was created. Public production remains immutable `v0.3.0`.

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
