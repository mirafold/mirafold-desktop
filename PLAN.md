# Mirafold Desktop — plan

Started 2026-08-02. The goal is a download other people can install and run,
on platforms where an unsigned build actually works.

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

- [x] **Step 3.1 — verify and plan the complete program.** Establish the exact
  current repository, npm, upstream provenance, packaging, updater, logging,
  navigation, permission, CI, Store, and hardware state; record the approved
  change/new/unchanged boundary and executable Steps in this document. No
  executable files change. Evidence: the facts above plus a clean starting
  worktree.
- [x] **Step 3.2 — replace the stale bundled baseline.** Pin `mirafold` exactly
  to the current proven npm `latest` and refresh only dependencies required to
  remove known advisories or take compatible patch releases. Verify npm
  signatures/provenance, exact lock resolution, `npm audit`, the focused tests,
  the full suite, and daemon entry/native-module resolution. Record dependency
  size and audit changes separately from application behavior.
  **Completed 2026-08-13:** `package.json` and the lock now pin
  `mirafold@0.3.7`, `electron@43.4.0`, and the already-current
  `electron-builder@26.15.3` exactly. The only advisory-bearing transitive node
  moved from `hono@4.12.33` to the first fixed patch, `4.12.34`; no override or
  direct dependency was added. A clean `npm ci` reconstructed all 371 installed
  packages, `npm audit` moved from one moderate node/four advisories to zero,
  and `npm audit signatures` verified all 371 auditable packages (54 with
  attestations). Mirafold's SLSA attestation binds `0.3.7` to
  `mirafold/mirafold`, tag `v0.3.7`, commit `1723a2d`.

  **Dependency cost:** the lock remains 400 entries total (399 registry-sourced
  and integrity-hashed), exactly the pre-update counts. Mirafold's own unpacked
  npm payload grew from 5,063,377 bytes/17 files to 5,174,773 bytes/19 files:
  +111,396 bytes (2.2%) and two files. The final clean `node_modules` is 728,952
  KiB. The earlier 1,028,784-KiB checkout included a separately downloaded
  Electron runtime that `npm ci` removes, so that apparent 299,832-KiB decrease
  is not claimed as a dependency saving. npm 12 reported two blocked fallback
  install scripts; direct probes nevertheless loaded the shipped
  `@lydell/node-pty` and `@parcel/watcher` native bindings. Windows packaged
  behavior remains deliberately unclaimed until its later native-runner and
  human Steps.

  **Application behavior:** no Desktop source changed in this Step. Its bundled
  upstream product moved across Shell releases `0.3.1`–`0.3.7`, taking the
  pre-trust Gemini-settings correction, native startup folder selection,
  session discovery/recovery and continuity, Codex/Ollama fixes, explorer
  polish, and the upstream correctness/security sweep. Verification: clean
  install; 14/14 Desktop tests; zero audit findings; signature/provenance check;
  exact daemon entry resolution; both native bindings loaded; `npm ls` clean;
  and `git diff --check` clean.
- [x] **Step 3.3 — make child-output secrecy stream-safe.** Change the existing
  daemon output path so neither the auth URL token nor relay pairing credential
  can reach Desktop stdout, stderr, or crash text, including when every possible
  boundary splits the sensitive label/value. Preserve private URL extraction
  for `BrowserWindow.loadURL` and useful bounded diagnostics. Add direct tests
  for intact, split, adjacent, and ordinary text.
  **Completed 2026-08-13:** a direct pre-change probe reproduced both causes:
  joining separately redacted `...?tok` / `en=dummy-token` chunks reconstructed
  the complete token, while an intact bundled `[relay] ... pairing code:
  dummy-code` line was not matched at all. `src/daemon.js` now routes both child
  streams through a bounded `CredentialSafeLineStream`. It withholds incomplete
  logical lines, redacts complete token and pairing-code values, safely flushes
  an unterminated final line, and replaces any line over 16,384 characters with
  a fixed marker without releasing its prefix. Only sanitized text reaches
  Desktop stdout/stderr and the bounded crash buffer. Child `close` now owns the
  crash callback so pipe tails are sanitized before diagnostic text is read.

  Raw stdout remains private inside the process long enough for
  `findStartupUrl()` to return the daemon's complete token-bearing URL; its
  accumulated tail is cleared immediately after extraction. Tests cover every
  possible single split and one-character chunking for both credential forms,
  with and without a final newline; adjacent credentials; ordinary CRLF/text
  preservation; final flush/idempotence; overlong-line elision; crash-buffer
  delivery; and incomplete-versus-complete startup URLs. Verification: focused
  daemon test passed, full suite 19/19, `node --check src/daemon.js`, zero npm
  audit findings, and `git diff --check`. No real credential or relay connection
  was used.
- [x] **Step 3.4 — bind the renderer to its daemon.** Change navigation from
  “any `127.0.0.1` port” to the exact current daemon origin, reset that origin
  during folder switches/failures, and install explicit deny-by-default
  Electron permission-check and permission-request handlers. Unit-test the pure
  policies and re-run the existing navigation/lifecycle suite.
  **Completed 2026-08-13:** the direct pre-change policy probe returned
  `allow` for both the intended `127.0.0.1:31337` daemon and an unrelated
  `127.0.0.1:49999` listener. `src/navigation.js` now validates the daemon's
  explicit `http://127.0.0.1:<port>/...` startup form, reduces it to its
  canonical web origin, and allows only that origin for the current launch.
  The equivalent post-change probe kept the daemon at `allow` and changed the
  unrelated listener to `external`.

  `src/main.js` now validates the private startup URL without ever putting it
  into an error, sets the trusted origin immediately before the daemon page is
  loaded, and clears it at boot start, folder replacement, load/boot failure,
  daemon crash, window close, and quit. A shared guard covers every frame's
  user/page navigation and server-side redirects; external main-frame pages
  still open in the real browser, while external subframes are refused.
  New dependency-free `src/permissions.js` installs both Electron permission
  handlers and denies every renderer permission request/check.

  Tests now prove exact-origin/path behavior, other loopback ports, absent
  origin, protocol/host lookalikes, explicit port validation including
  canonical port 80, and both permission handler paths across known and future
  permission names. Verification: focused navigation/permission tests, full
  suite 22/22, syntax checks for all three touched source modules, and
  `git diff --check`. No dependency, updater, release, packaging, or Shell
  executable behavior changed in this Step. Actual Electron event delivery and
  packaged behavior remain unverified here and belong to Step 3.5's runtime
  probes.
- [x] **Step 3.5 — verify the hardened local application.** Run the complete
  suite, dependency audit/signature verification, Linux packaged build, daemon
  boot, real UI load, terminal/native watcher probes, navigation/permission
  probes, and clean process-tree teardown. Record anything this machine cannot
  observe as unverified rather than passing it by inference.

  **Completed 2026-08-13 — packaging corrections:** the first direct Linux
  build failed while electron-builder's default `npmRebuild: true` path tried
  to compile `@parcel/watcher` from its wrapper `binding.gyp`. That wrapper
  actually selects an npm-installed N-API platform package; both it and
  `@lydell/node-pty` already loaded successfully against Electron's runtime.
  `electron-builder.yml` now sets `npmRebuild: false`, preserving npm's exact
  platform selections instead of attempting the wrong source build. A
  packaging test pins the setting and directly loads both wrappers.

  The first successful build then supplied two further concrete findings.
  Electron-builder warned that package metadata lacked `desktopName`, so Linux
  shell/window association was not guaranteed; `package.json` now sets
  `desktopName: mirafold.desktop`, matching `linux.desktop.entry.StartupWMClass`
  through the existing `syncDesktopName: true` behavior. The generated Debian
  entry is consequently installed as `mirafold.desktop`, launches
  `/opt/Mirafold/mirafold`, and declares `StartupWMClass=mirafold`. Separately,
  electron-builder's default AppImage desktop entry contained unconditional
  `Exec=AppRun --no-sandbox %U`. Explicit `appImage.executableArgs: []` removes
  that unconditional flag; the final entry is `Exec=AppRun %U`. The generated
  `AppRun` still retains its upstream compatibility fallback, adding
  `--no-sandbox` only when its exact `unshare -Ur true` capability probe fails.
  Configuration tests pin both Linux identity and the absence of an
  unconditional AppImage sandbox opt-out. The existing deliberate
  `asar: false` behavior is unchanged.

  **Final artifact evidence:** one uninterrupted `npm run dist:linux` completed
  with exit 0 and produced all configured targets: a 340,178,742-byte AppImage
  (`b49b30fb670dfe1f767252562c7267931378d05262df517c36e7325f8a9fb5b3`),
  a 322,160,154-byte gzip tarball
  (`0ba15fc396bc5cce4856eac3e52a04c6e8d25c314c5c2337d2c0ff0c700a0cc1`),
  and a 258,785,184-byte Debian package
  (`0bcf9774639d8283dc2684353b5f7bd5a1d84acc820bd8dbf7dc8bd2efd0ae6f`).
  File-type probes, `gzip -t`, Debian control metadata, fresh extraction, and
  embedded desktop/control-script inspection all passed. Executing the payload
  extracted independently from every format reported Desktop `0.1.1`, Shell
  `0.3.7`, Electron `43.4.0`, and Node `24.18.1`; both native wrappers loaded in
  all three. Checkout, unpacked-build, and final-AppImage hashes match for every
  changed runtime module.

  **Final runtime evidence:** the packaged daemon booted with its URL token
  redacted, accepted an authenticated WebSocket, created a non-networked demo
  session, returned real PTY output, observed and read back a watched file, and
  removed its complete four-process tree on `stop()` without firing the crash
  callback. A real final BrowserWindow loaded the loopback UI with the token
  removed from its visible URL; the agent cards and controls rendered; camera,
  microphone, geolocation, notifications, popups, and non-web navigation were
  denied; exact-origin navigation remained allowed; and Chromium directly
  reported `ERR_BLOCKED_BY_CSP` for a foreign-loopback iframe. That iframe's
  JavaScript-side boolean was inconclusive because cross-origin access itself
  is restricted, so it is not counted as a passing assertion. Visual inspection
  confirmed the expected agent-selection screen. Closing the window removed
  the complete eight-process BrowserWindow/daemon tree and the app exited 0.

  An early probe accidentally inherited relay-enabling process configuration
  and made one relay connection before the harness was corrected. It did not
  call a model and the pairing credential remained redacted. Every final daemon
  and UI probe explicitly unset known model/relay credential variables, set the
  relay and local discovery off, and isolated its state.

  **Observed platform limit:** the unpacked tree has a user-owned mode-0755
  `chrome-sandbox`, so its real-window probe required the explicitly test-only
  `--no-sandbox` launch flag. More importantly, this machine passes the weaker
  `unshare --user true` probe but fails AppImage's exact `unshare -Ur true` probe
  with `write failed /proc/self/uid_map: Operation not permitted`. The exact
  extracted AppImage launcher therefore selected its conditional
  `--no-sandbox` fallback; its process table proved the flag, while the real UI
  and clean teardown still passed. The AppImage is operational here but does
  **not** have Chromium process sandboxing here. The Debian installer contains
  electron-builder's user-namespace/setuid-helper selection and AppArmor setup,
  but its installed sandbox behavior is unverified because this Step did not
  perform a privileged system installation. Direct compositor association is
  also unverified because the observed Electron session uses native Wayland,
  where `xprop` cannot observe `WM_CLASS`; only the generated matching metadata
  is proven. Windows remains unverified until the native-runner and human Steps.

  **Repository verification:** 26/26 tests pass; `npm audit` reports zero
  vulnerabilities; all 371 registry signatures verify, with 54 attestations;
  `npm ls --all` is clean apart from expected unused-platform optional packages;
  and `git diff --check` is clean.

### Phase 4 — the one-time bridge and Windows/Linux updater

- [x] **Step 4.1 — implement the main-process updater.** Add
  `electron-updater` as the one runtime dependency: update protocols, checksum
  handling, installer lifecycle, and Windows signature validation are a
  security-sensitive specification and should not be reimplemented locally.
  Measure its installed/transitive cost. Create an injectable updater module
  that runs only when packaged, never competes with Microsoft Store updating,
  checks after startup and through a Help-menu command, reports failure without
  breaking Mirafold, downloads in the background, and installs only after a
  clean daemon shutdown. Display Desktop and bundled Shell versions separately.

  **Completed 2026-08-13 — updater policy and integration:** the verified
  pre-change application had no updater dependency, updater module, update
  command, or update call. `electron-updater@6.8.9` is now an exact production
  dependency; its release-metadata parsing, SHA-512 validation, download cache,
  platform installers, and signed-NSIS validation surface are deep and
  security-sensitive enough to justify the package. New dependency-free
  `src/updater.js` keeps Mirafold's policy injectable and directly testable. It
  does not even load `electron-updater` in development or when Electron reports
  `process.windowsStore === true`. Eligible packages check once after the real
  Mirafold UI boots and expose **Help → Check for Updates…**; the same menu
  displays the independent Desktop and bundled Shell versions.

  The controller downloads in the background, disables automatic installation
  on ordinary quit, refuses downgrades and NSIS web installers, asks before
  restart, and lets **Later** reopen the cached verified download without a
  second feed query. Background failures are sanitized and logged without
  interrupting or closing Mirafold; manual failures receive a nonfatal native
  explanation. Query values named `access_token`, `auth`, `key`, or `token` and
  electron-updater's staging user UUID are redacted before diagnostics leave
  the controller. A download can invoke `quitAndInstall(false, true)` only after
  the injected lifecycle callback returns literal `true`; refusal preserves
  the download, while a synchronous installer failure restores the daemon and
  leaves the current application usable.

  **Clean-shutdown proof:** the existing `Daemon.stop()` returned immediately;
  on Windows it started `taskkill /T /F` without observing completion. That was
  insufficient evidence for opening an installer over the running application.
  `src/daemon.js` now returns one shared `Promise<boolean>` for an in-flight
  stop. Unix sends `SIGTERM` to the daemon's process group, polls for complete
  disappearance, escalates to `SIGKILL`, and fails closed if the group remains.
  Windows waits up to ten seconds and accepts only exit code 0 from
  `taskkill /T /F`; disappearance of the parent alone is deliberately not
  treated as proof that descendants stopped. Ordinary quit may still ignore
  the Promise and receives its immediate signal as before. The update path
  freezes overlapping boots, awaits the proof, and never opens the installer
  after a false result. A real Linux test creates a detached leader and
  grandchild and proves both PIDs are absent when termination resolves.

  **Dependency cost:** the lock grew from 400 to 405 package entries and a
  clean install from 371 to 376 packages. The clean `node_modules` tree grew
  from 728,952 KiB to 730,172 KiB: **+1,220 KiB**. The installed
  `electron-updater` directory is 1,100 KiB; the separately materialized new
  roots are `lodash.escaperegexp` (24 KiB), deprecated `lodash.isequal`
  (68 KiB), and `tiny-typed-emitter` (28 KiB), while its other direct
  dependencies were already present and deduplicated. Its npm payload is
  565,021 unpacked bytes and it declares eight direct dependencies. The
  `lodash.isequal` deprecation is accepted as upstream cost, not hidden as an
  application choice; `npm audit` reports no vulnerability in it or the final
  tree. A packaging test pins the updater as an exact runtime—not development—
  dependency.

  **Packaged/runtime evidence:** a fresh `npm run pack` included
  `electron-updater`, Desktop `0.1.1`, Shell `0.3.7`, Electron `43.4.0`, and
  Node `24.18.1`; checkout and packaged hashes match for the updater, main, and
  daemon modules. Electron-builder inferred the public GitHub repository into
  packaged `app-update.yml`. A real packaged BrowserWindow then performed its
  startup request to the production release feed. GitHub returned the expected
  404 because the older `v0.1.1` release has no `latest-linux.yml`; that
  diagnostic redacted the generated staging UUID, the Mirafold UI remained
  loaded and interactive, all permission/navigation probes retained their
  Step 3.5 results, and closing removed the complete eight-process tree with
  application exit 0. This is direct proof of startup checking and nonfatal
  feed-failure isolation, not a successful update claim; publishing complete
  metadata is Step 4.2.

  **Verification and limits:** clean `npm ci`; focused updater/daemon/packaging
  tests; full suite **38/38**; syntax checks for all three changed runtime
  modules; zero npm audit findings; all 376 registry signatures verified, with
  56 attestations; `npm ls --all` clean apart from expected absent-platform
  optional packages; and `git diff --check` clean. Development and Store gates,
  update/defer/install/recovery state transitions, and a false shutdown proof
  are unit-proven. Actual AppImage/`.deb` replacement, tar notification,
  successful update transition, checksum rejection, rollback recovery, and
  Windows `taskkill`/NSIS behavior remain unverified until Steps 4.3, 4.4, and
  6.1–6.2. The current direct Windows build is unsigned, so signed-NSIS
  publisher validation is present in the library but is not active or claimed
  for today's artifact. Microsoft Store suppression is proven at the policy
  boundary against Electron's reported flag, not yet in a real Store package.
- [x] **Step 4.2 — publish complete updater releases.** Configure the public
  GitHub provider and update channels in `electron-builder.yml`; make CI retain
  and publish every required `latest*.yml`, checksum, blockmap, installer, and
  package file atomically. Add static workflow/configuration tests that fail if
  metadata is omitted, a tag/version diverges, a prerelease becomes stable, or
  a build job receives repository-write permission.

  **Completed 2026-08-13 — explicit feed and exact release contract:** the
  verified pre-change builder configuration had no explicit publication
  provider, while the release workflow built with `--publish never`, retained
  only `.deb`, `.tar.gz`, `.AppImage`, and `.exe` files, and passed those files
  directly to a public `gh release create`. It therefore omitted both updater
  metadata files and the Windows NSIS blockmap. The observed public `v0.1.1`
  release confirms that state: it has exactly those four installer/package
  assets and no `latest-linux.yml`, `latest.yml`, or `.exe.blockmap` asset.

  `electron-builder.yml` now names one public GitHub provider explicitly:
  owner `mirafold`, repository `mirafold-desktop`, stable channel `latest`,
  `private: false`, and `publishAutoUpdate: true`; all-channel metadata remains
  disabled. Build jobs still use `--publish never`, so that setting generates
  feed metadata without giving dependency code a publication credential.
  `scripts/release-contract.mjs` is a new, Node-standard-library-only gate for
  the exact release set, expanded by Step 5.4 from seven to nine files:

  - Linux: `Mirafold-VERSION.AppImage`, `latest-linux.yml`,
    `mirafold-desktop-VERSION.tar.gz`, and
    `mirafold-desktop_VERSION_amd64.deb`, and `SHA256SUMS-linux.txt`;
  - Windows: `Mirafold-Setup-VERSION.exe`, its external `.exe.blockmap`, and
    `latest.yml`, and `SHA256SUMS-windows.txt`.

  The gate rejects non-stable versions and tags that are not exactly
  `v${package.json.version}`; missing, extra, empty, or duplicate release
  assets; unsupported or duplicate metadata fields; metadata/payload version,
  name, size, or SHA-512 divergence; malformed AppImage embedded blockmaps;
  malformed Windows gzipped blockmaps; and remote draft assets whose names or
  sizes differ from the locally verified set. Its narrow YAML parser accepts
  only electron-builder's observed UpdateInfo shape, deliberately avoiding a
  dependency install in the only job that receives `contents: write`.

  **Atomic visibility:** each read-only native build verifies its complete
  platform set before `actions/upload-artifact` retains metadata, blockmaps,
  installers, and packages. The isolated release job installs no npm packages,
  merges both verified artifacts, verifies the complete nine-file set, and
  refuses to replace an existing release. It creates a non-latest draft,
  uploads the files, queries GitHub's remote asset list, and rechecks the exact
  remote names, byte sizes, and GitHub-calculated SHA-256 digests while the
  release is still a stable draft. Only
  then does it make the release public and mark it latest. A failed local check
  or upload removes only the newly created draft; after the publish request is
  sent, an uncertain response deliberately leaves the complete release in
  place rather than risking deletion of a release that may already be public.
  The workflow default and both build jobs remain `contents: read`, checkout
  credentials are not persisted, and tests pin the rule that no fork event can
  enter this workflow.

  **Real Linux artifact proof:** a fresh `electron-builder@26.15.3` build with
  the new explicit provider produced a 340,744,720-byte AppImage, a
  259,146,932-byte Debian package, a 322,622,599-byte tar archive, and the
  531-byte `latest-linux.yml`. The packaged `app-update.yml` contains the exact
  public owner, repository, provider, channel, privacy, and auto-update values.
  The new gate independently recomputed both metadata payloads' SHA-512s and
  sizes and decompressed/validated the real AppImage's 354,852-byte embedded
  blockmap successfully. The Windows contract is grounded in the installed
  electron-builder version's NSIS output names plus direct valid/invalid
  metadata and gzipped-blockmap fixtures; actual native Windows output remains
  unverified until the Windows CI and human-runtime Steps 6.1–6.2.

  **Verification and limits:** release workflow YAML parses; focused release,
  packaging, and workflow tests pass; the full suite passes **50/50**; all
  changed JavaScript modules pass syntax checks; `npm audit` reports zero
  vulnerabilities; all 376 registry signatures verify, with 56 attestations;
  `npm ls --all` exits cleanly apart from expected absent-platform optional
  packages; and `git diff --check` is clean. No tag, draft, public release, or
  repository write was created during this local Step. A real native Windows
  build and the first full GitHub draft-to-public transition therefore remain
  deliberately unclaimed; they require committed source and a release tag and
  belong to the later CI/release validation Steps rather than being tested by
  mutating the live release feed here.
- [x] **Step 4.3 — prove each Linux distribution form.** Build two local
  packaged versions and exercise the supported update path for AppImage and
  `.deb` without contacting the production feed. Verify authentication/elevation
  behavior and clean daemon shutdown during installation. Give `.tar.gz` users
  an explicit in-app new-version notice and direct HTTPS release link if safe
  replacement cannot be proven. Update the support table from observations,
  not generic library documentation.

  **Completed 2026-08-13 — distribution-aware behavior proven with two real
  build versions:** before this Step, `src/updater.js` applied the same direct
  updater policy to every packaged non-Store application. The installed
  `electron-updater@6.8.9` selected AppImage by default on Linux, selected its
  Debian updater only when `resources/package-type` contained `deb`, and found
  neither identity marker in the extracted tar archive. The observed tar result
  was therefore a silent no-update result, not a working replacement path.

  `src/updater.js` now makes the installed form an explicit policy decision:
  genuine AppImage and exact Debian markers use the native updater; unknown
  Linux forms fail safe to a check-only notice; development builds are disabled;
  and future Microsoft Store packages remain wholly Store-managed. `src/main.js`
  reads the trusted packaged Debian marker, recognizes AppImage's runtime
  identity, creates a bare `AppUpdater` for check-only tar use, and opens only
  the fixed HTTPS URL
  `https://github.com/mirafold/mirafold-desktop/releases/latest`. The tar path
  sets all download/install flags false, never prepares an install or stops the
  daemon, and reopens a cached notice after **Later** without another feed
  request. AppImage and Debian retain the explicit install-and-restart choice
  and must prove the daemon process tree is gone before reaching the platform
  installer.

  The retained local old build used source version `0.1.1`; the new build
  overrode only packaged metadata to create `0.1.2` without changing the source
  version. Old/new sizes were respectively 340,744,720/340,744,753 bytes for AppImage,
  259,146,932/259,148,208 bytes for Debian, and
  322,622,599/322,623,041 bytes for tar. The new release contract independently
  verified its metadata and hashes. Direct archive inspection established that
  the Debian package alone contains `resources/package-type` with exact value
  `deb`; AppImage and tar do not. The packaged `src/main.js` and
  `src/updater.js` extracted independently from all three new artifacts have
  the same SHA-256 hashes as the checkout, so every new `0.1.2` distribution
  artifact carries the exercised policy.

  `scripts/linux-update-probe.mjs` is a new local-only, disposable integration
  probe. It served the `0.1.2` metadata and payloads only over IPv4 loopback and
  exercised the real update provider, version comparison, SHA-512 validation,
  downloader, cache, and platform updater classes. It also started the real
  Mirafold daemon from the exact dependency included in the artifacts twice,
  with its remote relay explicitly disabled and its saved-session directory
  redirected into the disposable probe root, and
  proved that the daemon URL became unreachable before either installer path
  ran. Its observed support table is:

  | installed form | observed supported path | authorization/elevation boundary |
  | --- | --- | --- |
  | AppImage | Downloaded and hash-verified `0.1.2`, removed only a disposable hard link to `0.1.1`, moved the replacement into that user-writable directory, preserved executable mode, and selected the replacement as the relaunch target. | None; no elevation helper was called. |
  | `.deb` | Downloaded and hash-verified the exact `0.1.2` Debian payload, selected the host's real `dpkg`, stopped the daemon, and reached the real Debian install-command construction. | As this non-root user, the installed updater selected real `/usr/bin/pkexec` and constructed `pkexec --disable-internal-agent /bin/bash -c 'dpkg -i <verified-deb>'`. The command was captured immediately before execution; it was not run. |
  | extracted `.tar.gz` | Requested `latest-linux.yml` once, requested zero payloads, displayed the native notice, and opened only the fixed official HTTPS Releases URL. | None; no files changed and the daemon remained running. |

  The Debian privilege boundary is intentionally literal: no package was
  installed into this host, and no interactive authorization dialog was
  invoked. Privileged system mutation and password interaction belong to Kyle,
  so the exact dialog appearance, cancellation behavior, and successful host
  install remain unverified rather than inferred. This Step also does not claim
  a production-feed update, checksum rejection, rollback, or a native Windows
  transition; those are Steps 4.4 and 6.1–6.2.

  **Verification:** the disposable two-version probe passes; focused updater
  and packaging tests pass; the full suite passes **53/53**; all 376 registry
  signatures verify with 56 attestations; `npm audit` reports zero
  vulnerabilities; `npm ls --all` exits cleanly apart from expected
  absent-platform optional packages; and `git diff --check` is clean. No
  production update feed, release, tag, privileged command, or remote GitHub
  repository write was created.
- [x] **Step 4.4 — prove the bridge boundary.** Verify that `v0.1.1` itself
  cannot update; install a bridge candidate manually; publish or locally serve
  a higher candidate; prove discovery, checksum rejection, download, defer,
  restart, version change, and rollback-by-higher-version behavior. The bridge
  is not publicly released in this Step.

  **Completed 2026-08-13 — the one-time bridge and forward-only recovery path
  are now observed rather than assumed.** The exact public starting state was
  rechecked before the rehearsal. Tag `v0.1.1` has no `electron-updater`
  dependency, no `src/updater.js`, and no updater construction in
  `src/main.js`. GitHub's release API reports the published, non-draft,
  non-prerelease release still has exactly four assets: the 327,190,160-byte
  AppImage, 309,606,286-byte tar archive, 248,183,824-byte Debian package, and
  241,899,694-byte Windows installer. It has no `latest-linux.yml`,
  `latest.yml`, or blockmap. Even adding metadata later would not make that app
  check it: public `v0.1.1` itself contains no updater runtime. Its users
  therefore need exactly one manual move to the first updater-capable release.

  The local rehearsal built three AppImages from the current checkout without
  changing `package.json`: a `0.1.2` bridge carrying a test-only `known-good`
  payload marker, a `0.1.3` candidate carrying a distinct
  `simulated-regression` marker, and a `0.1.4` recovery carrying the restored
  `known-good` marker. Their sizes are 340,744,723, 340,744,698, and
  340,744,699 bytes. Each candidate's generated metadata version, URL, size,
  and SHA-512 were independently checked against the real AppImage. Narrow
  AppImage filesystem extraction established the embedded versions and marker
  states; all three embed the checkout's exact `src/updater.js` SHA-256,
  `812a95ce31453aea7606763cba8134206df0a321aedf57391ce2eadd620616d4`.
  The marker isolates the recovery mechanism from any invented product defect:
  it distinguishes payload state while executable source remains identical.

  `scripts/linux-update-probe.mjs --bridge` now performs the complete
  destructive portion only inside a fresh temporary directory and serves every
  update byte from IPv4 loopback. Copying `0.1.2` into its user-writable install
  directory is the manual AppImage bridge. From that exact file, the observed
  sequence is:

  1. A locally served `0.1.3` metadata file with canonical but false SHA-512
     values advertised the update and caused a full payload request. The real
     downloader reported a SHA-512 mismatch, emitted no `update-downloaded`,
     entered no install lifecycle, and left the bridge byte-for-byte unchanged.
  2. Correct `0.1.3` metadata was discovered and the 340,744,698-byte payload
     downloaded and verified. Choosing **Later** left the real daemon serving,
     left the current AppImage unchanged, and entered no install lifecycle. A
     second manual check reused that cached verified payload without making
     another feed request.
  3. Choosing install then produced the exact `prepare → stopped → install`
     lifecycle. The real Mirafold daemon from the exact dependency being
     packaged and its URL were gone before AppImage replacement, the installed
     bytes matched `0.1.3`, and the updater selected that replacement as its
     relaunch target. A fresh controller used `0.1.3` as current, and the
     corresponding unpacked packaged Electron executable from the same build
     independently reported embedded identity `0.1.3` /
     `simulated-regression` in non-GUI Node mode.
  4. From `0.1.3`, serving the old `0.1.2` proved that `allowDowngrade: false`
     refuses a numerically lower rollback before payload download or install.
  5. Serving `0.1.4` then produced another exact clean-shutdown/install
     lifecycle, hash-matched the installed recovery, selected it for relaunch,
     and independently reported embedded identity `0.1.4` / `known-good`. The
     final payload marker therefore matches the bridge while the Desktop version
     advances. This is the supported rollback mechanism: restore known-good
     source in a new higher release, never ask installed clients to downgrade.

  **Boundary kept literal:** the updater's relaunch command and exact target
  were exercised, and the corresponding unpacked executable from the identical
  build was run in Electron's non-GUI Node mode to report its embedded version.
  A full graphical process was not opened and driven through a virtual desktop,
  because this machine has
  neither Xvfb nor a UI automation driver. No production-feed transition or
  actual public bridge release is claimed; those require the later native CI,
  release, and human-runtime gates. The rehearsal used no privileged command,
  and both real daemon launches had the remote relay explicitly disabled and
  their saved-session storage isolated inside the disposable probe. The final
  reruns produced no access to Kyle's saved-session index.

  **Verification:** both the new bridge rehearsal and the original
  AppImage/Debian/tar probe pass after the script extension; the full suite
  remains **53/53**; all changed JavaScript parses; package and lock versions
  remain Desktop `0.1.1` / Shell `0.3.7`; and `git diff --check` is clean. No
  tag, draft, remote release asset, production-feed request, system
  installation, dependency change, commit, push, or remote GitHub write
  occurred.

### Phase 5 — zero-routine-work Shell-to-Desktop releases

- [x] **Step 5.1 — implement deterministic release preparation.** Create and
  test a dependency/version preparation command that accepts an observed npm
  version, verifies it is the proven `latest`, writes an exact Mirafold pin,
  refreshes the lockfile without unrelated churn, bumps the independent Desktop
  patch version once, and becomes an idempotent no-op when already current.

  **Completed 2026-08-13 — verified starting state:** `package.json` and
  `package-lock.json` already agreed on Desktop `0.1.1` and an exact
  `mirafold@0.3.7` pin. npm's public registry still identified `0.3.7` as
  `latest`; the lock's public tarball URL and SHA-512 integrity matched that
  registry record exactly. The repository had no release-preparation command
  or declared npm toolchain version. Creating those is new behavior; the
  existing Shell pin and lock resolution did not need correction in this Step.

  **Executable implementation:** new dependency-free
  `scripts/prepare-shell-release.mjs` accepts one stable `x.y.z` Shell version,
  requires the declared npm `12.0.2`, and queries the fixed public npm registry.
  It refuses stale observations, prereleases/ranges, downgrades, non-public
  Mirafold tarball URLs, malformed or mismatched SHA-512 integrity, and
  inconsistent package/lock state. For a new `latest`, it stages both manifests
  outside the checkout, increments the independent Desktop patch exactly once,
  and asks npm to generate only the lock with an exact Mirafold request,
  lifecycle scripts disabled, a blank user config, and an isolated cache. It
  re-queries `latest`, permits semantic lock changes only inside the union of
  the old and new Mirafold dependency closures, checks that the real files were
  not concurrently edited, then replaces the package/lock pair with rollback
  protection. A current exact pin returns before staging or writing anything.

  `package.json` now declares `packageManager: npm@12.0.2` and exposes
  `npm run release:prepare -- VERSION`. No third-party package was added: npm
  owns npm-lock resolution, while version/JSON validation and guarded file
  replacement are small standard-library work. The maintainer script is not in
  electron-builder's explicit installed-file set, so end users do not receive
  it.

  **Direct transition evidence:** a disposable copy was first resolved by real
  npm at Shell `0.3.6`, then the actual preparation implementation advanced it
  to Shell `0.3.7` and Desktop `0.1.2`. The generated lock passed the unrelated-
  churn guard and matched npm's recorded `0.3.7` tarball/integrity. A second run
  returned `changed: false`, retained Desktop `0.1.2`, and left both file hashes
  identical. On the real checkout, the same command observed current
  `mirafold@0.3.7`, returned `changed: false`, retained Desktop `0.1.1`, and
  preserved the exact package and lock hashes
  `006c0c4d08de033f5833472fba0a0e1f4b7a185899a4dd34ed44c7f07397aa39`
  and
  `2f9225219fdeac7b5bbc058a18b6b206ce411092f968225cfa2d1018e1b4028c`.

  **Verification:** 13 focused release-preparation cases cover exact version
  ordering/bumping, command wiring and flags, the state transition, byte-level
  idempotence, stale/latest races, rollback attempts, non-exact input, unrelated
  lock churn, integrity disagreement, exact npm enforcement, and concurrent
  edits. The full suite passes **66/66**; `npm audit` reports zero
  vulnerabilities; all 376 auditable packages have verified registry
  signatures and 56 have attestations; `npm ls --all`, the new module's syntax
  check, and `git diff --check` pass. Provenance-policy enforcement and the
  read-only scheduled consumer belong to Step 5.2; no workflow, credential,
  commit, tag, release, or installed-client behavior changed here. Native
  Windows execution remains unverified until the later Windows runner Step.
- [x] **Step 5.2 — implement scheduled Shell intake.** Add a serialized
  scheduled/manual workflow that discovers npm `latest`, verifies provenance
  and signatures in a read-only job, prepares and tests the exact source, and
  passes only reviewed package/version artifacts to later jobs. Dependency code
  must never run while a repository-write credential is available.

  **Completed 2026-08-13 — verified starting state:** the only workflow was
  `.github/workflows/release.yml`, triggered by a Desktop tag or manual
  rehearsal. No scheduled Shell workflow, npm-latest discovery, upstream source
  policy, or prepared-source artifact existed. That release workflow's existing
  tag/manual behavior is unchanged in this Step. npm still reported both
  `mirafold@0.3.7` and `npm@12.0.2` as `latest`. npm's verified Mirafold SLSA
  statement bound the package subject and SHA-512 bytes to
  `https://github.com/mirafold/mirafold`, `refs/tags/v0.3.7`, source commit
  `1723a2d6f5f2d08159d1acf7c5d496d3420882d9`,
  `/.github/workflows/release.yml`, and GitHub's hosted runner builder.

  **New read-only workflow:** `.github/workflows/shell-intake.yml` is scheduled
  at minutes 17 and 47 of each UTC hour and is manually dispatchable. A static
  concurrency group permits one active run without cancelling it; GitHub's
  single pending slot intentionally replaces an older pending observation with
  the newest. The first executable step refuses any repository other than
  `mirafold/mirafold-desktop` or ref other than `refs/heads/main`, covering the
  branch selector exposed by manual dispatch before checkout or npm runs. The
  workflow and both jobs declare only `contents: read`; both checkouts disable
  persisted credentials, and no write-scoped job exists.

  Intake installs the exact declared npm `12.0.2` with lifecycle scripts
  disabled and a blank isolated user config, then invokes the Step 5.1
  preparation boundary without putting registry data into a shell command. A
  current pin ends as `changed=false`; package installation, attestation work,
  artifact upload, and tests are skipped. A new pin is materialized with
  `npm ci --ignore-scripts`, then `npm audit signatures --json
  --include-attestations` must cryptographically accept the downloaded tree.
  No installed project dependency is executed in this job.

  **New source and artifact policy:** dependency-free
  `scripts/shell-intake.mjs` validates npm's verified SLSA payload again as
  project policy. It requires one Mirafold entry; the exact package/version and
  SHA-512 subject; the public registry; the canonical repository, matching
  `vVERSION` tag and release-workflow path; one 40-hex source commit; and the
  GitHub-hosted builder. Missing/invalid/ambiguous signatures or attestations,
  another repository/ref/workflow/builder, or different bytes all fail closed.
  This deliberately layers identity policy over npm's cryptographic verifier
  rather than attempting to implement Sigstore itself.

  Only `package.json`, `package-lock.json`, and compact `shell-intake.json`
  evidence enter the immutable seven-day Actions artifact. The raw Sigstore
  bundle and `node_modules` do not. The evidence binds both prepared file hashes
  and their pre-update package/lock hashes. A fresh read-only test job downloads
  that artifact, refuses it unless those base hashes match the same run's
  `github.sha` checkout manifests, applies the pair with rollback protection,
  installs without lifecycle scripts, runs `npm ls --all`, rejects moderate-or-
  higher advisories, runs the full suite, and confirms the reviewed manifests
  were not changed by dependency/test execution. The preparation helper now
  exports its already-existing guarded pair replacement for that consumer; its
  own CLI behavior is unchanged.

  **Dependency decision and verification:** no package was added. npm owns
  registry-signature and Sigstore/SLSA verification, a security-sensitive
  protocol surface; the repository code owns only its exact source policy,
  JSON/DSSE field checks, hashes, and three-file transfer contract using Node's
  standard library. Eight focused workflow assertions and 18 focused
  preparation/provenance/artifact assertions pass, including ten independent
  provenance-substitution refusals. The complete suite passes **92/92**;
  `npm audit` reports zero vulnerabilities; all 376 installed packages have
  verified registry signatures and 56 have verified attestations; `npm ls
  --all`, both new/modified script syntax checks, YAML parsing for both
  workflows, and `git diff --check` pass.

  A live local intake observed the current `0.3.7`, returned `changed=false`,
  and preserved the real package and lock hashes
  `006c0c4d08de033f5833472fba0a0e1f4b7a185899a4dd34ed44c7f07397aa39`
  and
  `2f9225219fdeac7b5bbc058a18b6b206ce411092f968225cfa2d1018e1b4028c`.
  The real npm JSON report separately showed zero invalid, zero missing, and 56
  attested entries, and its Mirafold source fields were directly inspected.
  This shell/tool wrapper discarded the long JSON stream whenever the command
  yielded, so the real raw bundle was not fed end-to-end through the new parser
  locally; fixture coverage proves the parser policy, not npm's future output.
  The actual GitHub workflow, expressions, immutable artifact transfer, and
  combined real-report parser path remain unverified until the changes exist on
  GitHub and the planned non-publishing rehearsal runs. No commit, tag,
  installer, release, repository write, or end-user behavior changed here.
- [x] **Step 5.3 — connect intake to cross-platform release.** Build Linux and
  Windows from the prepared source on native runners; run packaged smoke checks;
  and only after every gate succeeds let an isolated write job commit the exact
  dependency/Desktop-version change, tag it, create one GitHub Release, and
  attach the complete update set. Handle races, duplicate schedules, partial
  failure, and safe retry without publishing two versions or leaving a release
  feed pointing at missing assets.

  **Completed 2026-08-13 — verified starting state:** the Step 5.2 Shell-intake
  workflow ended after its read-only Linux test job. It had no native package
  matrix and no writer. The separate tag/manual release workflow did build on
  native Ubuntu and Windows runners and isolated its Release credential, but it
  did not consume the reviewed intake pair or run a packaged-runtime probe. No
  component existed that could reconstruct the exact candidate, verify the
  allowed Git tree, create the dependency/Desktop commit, advance `main` and a
  tag together, or classify/recover partial automated publication. Public
  `v0.1.0` and `v0.1.1` still contained only four legacy package/installer
  assets, with no update metadata or blockmap. Remote `main` was
  `bee5bd51a0a60f93381e7bee60815ce839f9dfbf`; the two existing version tags were
  annotated; the repository's default Actions permission was read-only; and
  `main` had no branch-protection rule. No repository Actions variable existed.

  **Native read-only build gates:** `.github/workflows/shell-intake.yml` now
  fans the one immutable intake artifact into native `ubuntu-latest` and
  `windows-latest` jobs only after intake and the independent test job pass.
  Each checks out the run's fixed source without a persisted credential,
  applies the hash-bound package/lock pair, installs with lifecycle scripts
  disabled and npm `12.0.2`, validates the full tree and advisory state, verifies
  registry signatures/attestations on that operating system, and runs the full
  suite. It invokes the already-installed `electron-builder` CLI directly with
  `--publish never`; no `npx` fallback can fetch different code. Only after the
  build does it recheck the reviewed manifests, verify the exact platform
  updater contract, and retain one seven-day native artifact.

  New dependency-free `scripts/packaged-smoke.mjs` starts the built Electron
  executable under `ELECTRON_RUN_AS_NODE=1` with a small environment and no GUI,
  daemon, model, or relay. From the actual packaged application root it proves
  the source Desktop version, exact bundled Shell version, Desktop main entry,
  real `mirafold/dist-server/index.js` daemon entry, and successful loads of
  `@lydell/node-pty` and `@parcel/watcher`. Its first real package run correctly
  rejected an unverified probe assumption: `mirafold/dist/daemon/entry.js` does
  not exist. Direct inspection established that `src/daemon.js`, the installed
  Shell, and the packaged Shell all use `dist-server/index.js`; the probe and
  fixture were corrected to that observed contract before the same real package
  passed. The manual/tag release workflow now runs this smoke gate too, uses the
  local builder path, verifies public/latest state after publication, and shares
  the publication lock described below.

  **New isolated writer:** `scripts/release-coordinator.mjs` uses Node's
  standard library and the repository-owned intake/release policy modules only.
  The write job installs no package and runs no dependency, test, builder, or
  downloaded executable. It applies the exact intake pair to a clean checkout
  at the run's recorded `github.sha`, verifies all nine combined artifacts,
  refuses any worktree/index change except `package.json` and
  `package-lock.json`, stages only those two files, and records the exact Git
  tree, two file hashes, platform asset names/sizes/SHA-256s, stable tag/title/messages,
  Shell source tag/commit, and generated-notes hash in a bounded release plan.
  A disposable Git repository proves that this real path reconstructs and
  stages only the pair, commits the recorded tree, makes an annotated tag, and
  passes the independent local commit/parent/tree/message/tag verifier.

  The writer then reads GitHub's `main`, commit/tree, peeled tag, release, and
  latest-release state before it mutates anything. A fresh candidate is allowed
  only while remote `main` still equals the intake base and its target tag and
  release are absent. It creates one commit and annotated tag locally, verifies
  them, then uses `git push --atomic` for the branch and tag: a concurrent main
  advance or tag collision updates neither ref. Both release workflows share
  the non-cancelling `mirafold-desktop-publication` job lock. GitHub documents
  that pushes made with this workflow's `GITHUB_TOKEN` do not start a second
  push workflow, so the scheduled writer publishes directly instead of racing
  the tag workflow.

  **One complete release or no feed change:** after the possible push, remote
  identity is classified again. The only resumable commit must have exactly the
  intake base parent, reviewed candidate tree, generated message, and annotated
  tag. No release creates a draft; a complete matching draft resumes at public
  promotion; an incomplete draft is deleted and recreated without deleting its
  tag; and an already-public complete latest release is an idempotent no-op.
  A stale/different commit, lightweight or colliding tag, published prerelease,
  incomplete public asset set, or non-latest public result fails closed. Local
  artifacts and generated notes are verified before upload. Remote title,
  notes hash, asset names, and byte sizes are verified while the release is
  still a stable draft; only then is it made public/latest and verified again.
  Failure before that point either
  removes a newly incomplete draft or leaves a complete draft; an uncertain
  publish response deliberately preserves it. Re-running the failed jobs of
  the same workflow run uses its original SHA and immutable artifacts and can
  safely resume the exact commit/tag/draft/public state. Rapid different Shell
  candidates aimed at the same Desktop patch collide and abort rather than
  overwrite one another; the next schedule from the advanced `main` selects the
  following patch.

  **Deliberate activation boundary:** the writer job additionally requires the
  non-secret repository variable `MIRAFOLD_AUTOMATED_RELEASES` to equal exactly
  `enabled`. It is currently absent, so merging this implementation cannot
  create a commit, tag, draft, or public release. This preserves the approved
  one-time bridge order: Step 5.5 first rehearses without publication, Step 7.3
  publishes the updater bridge with explicit approval, and only then may that
  variable be set for subsequent routine Shell releases. No GitHub setting,
  variable, ref, workflow run, artifact, or release was changed remotely here.

  **Dependency decision and verification:** no package was added. npm remains
  responsible for its security-sensitive registry/signature/provenance
  protocols; electron-builder remains the existing native packager; Git and
  GitHub CLI own ref and Release protocols. The new code owns only fixed policy,
  hashing, JSON/API normalization, subprocess arguments, and state
  classification, for which a dependency would add supply-chain surface without
  useful hardening. Twelve intake-workflow assertions, ten manual-release
  assertions, seven coordinator cases, three packaged-smoke cases, and seven
  release-contract cases pass. The complete suite passes **107/107** including
  nested provenance-substitution cases. A real existing Linux package reports
  Desktop `0.1.1`, Shell `0.3.7`, the bundled `dist-server/index.js`, and both
  native wrappers loaded. Both workflows parse as YAML; all new/modified scripts
  pass Node syntax checks; the full installed dependency tree is valid;
  `npm audit` reports zero vulnerabilities; npm reports 376 packages with
  verified registry signatures and 56 with verified attestations; and
  `git diff --check` passes. The real package and lock hashes remain
  `006c0c4d08de033f5833472fba0a0e1f4b7a185899a4dd34ed44c7f07397aa39`
  and
  `2f9225219fdeac7b5bbc058a18b6b206ce411092f968225cfa2d1018e1b4028c`.

  **Limits kept explicit:** no new native installer was built in this Step; the
  real smoke used the already-existing Linux unpacked build, while actual
  Windows packaged execution still requires the workflow runner and the deeper
  daemon/installer proof in Step 6.1. GitHub has not parsed or executed the new
  workflow, transferred its artifacts, exercised its live API/writer token, or
  observed a real partial publication. Those no-publication scenarios belong to
  Step 5.5. No installed-client update or public bridge behavior is claimed.
- [x] **Step 5.4 — harden release identity and recovery.** Pin all GitHub
  Actions by reviewed commit SHA, generate GitHub artifact provenance and
  SHA-256 manifests, use least-privilege job tokens and environments, document
  key/account recovery, and prepare exact repository ruleset/Dependabot/secret
  scanning settings. Apply external GitHub settings only after their effect on
  Kyle's merge and automated-release flows is demonstrated.

  **Completed 2026-08-13 — digest-bound builds and recoverable repository
  policy:** direct inspection established the exact pre-change boundary. Both
  workflows used moving `actions/checkout@v5`, `actions/setup-node@v5`,
  `actions/upload-artifact@v4`, and `actions/download-artifact@v4` references;
  the release contract expected seven files and remote release verification
  compared only names and byte sizes; no Desktop CI workflow, Dependabot file,
  repository-policy file, recovery guide, environment, or ruleset existed.
  Read-only GitHub APIs also established that the public repository had
  read-only default Actions tokens and Dependabot alerts enabled, but no
  environments/rulesets, Dependabot security updates, private vulnerability
  reporting, repository secret scanning, or repository push protection. Merge,
  squash, and rebase were all allowed and merged branches were not deleted.

  **Reviewed immutable action identities:** every action use in all three
  workflows is now a 40-hex commit whose GitHub commit signature was directly
  reported valid: `actions/checkout` `v7.0.1` at
  `3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/setup-node` `v7.0.0`
  at `820762786026740c76f36085b0efc47a31fe5020`,
  `actions/upload-artifact` `v7.0.1` at
  `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`,
  `actions/download-artifact` `v8.0.1` at
  `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`, and the current recommended
  `actions/attest` `v4.2.2` at
  `1e69f48acb82d1966a394da916b4c1698aa569d6`. A whole-workflow assertion
  rejects moving, unknown, or undocumented action references. Weekly
  GitHub-Actions Dependabot pull requests are the review path for future pin
  movement.

  **Nine-file integrity and provenance:** each native build now verifies its
  raw platform payloads, creates canonical sorted
  `SHA256SUMS-linux.txt`/`SHA256SUMS-windows.txt`, and then re-verifies the
  final exact platform set. The complete release comprises four original Linux
  files plus its manifest and three original Windows files plus its manifest.
  Missing/extra/empty payloads, pre-existing manifests, noncanonical lines, and
  post-manifest byte changes fail. The isolated release plan schema now records
  every local SHA-256. GitHub's current release API documents and the live
  `v0.1.1` assets directly demonstrate server-calculated `sha256:` digests; both
  writers now require those remote digests—not merely equal sizes—to match
  before a draft becomes public and again after publication.

  After the two native jobs, a separate provenance job downloads and verifies
  the merged nine-file set and uses the pinned `actions/attest` implementation
  to create SLSA build provenance for every subject. Only that job receives
  `id-token: write`, `attestations: write`, and `artifact-metadata: write`; it
  has `contents: read`, persists no checkout credential, installs no package,
  and cannot publish. Build/test jobs remain `contents: read`; the dependency-
  free final writer alone receives `contents: write` and cannot run until the
  provenance job succeeds. A scheduled intake creates no otherwise-unused
  attestation while publication is disabled; a deliberate manual rehearsal can
  exercise provenance without enabling the writer.

  **CI, dependency review, and environment contracts:** new
  `.github/workflows/ci.yml` supplies stable `test (linux)` and
  `test (windows)` checks for `main`, pull requests, and manual dispatch. Both
  jobs use the exact npm `12.0.2` toolchain with lifecycle scripts disabled,
  validate the tree/advisories/signatures/attestations, and hold only a
  non-persisted read token. New `.github/dependabot.yml` opens weekly npm and
  immutable-action pull requests. Its three `update-types` exclusions keep
  routine `mirafold` version movement owned by verified Shell intake while
  preserving Dependabot security updates.

  Workflow source now assigns the routine writer to `automated-release` and
  the tag writer to `manual-release`. The exact un-applied environment policy
  allows only the `main` branch with no reviewer for routine automation, and
  only `v*` tags with Kyle (GitHub user ID `32747715`) as reviewer for manual
  publication. Self-review remains allowed so a solo maintainer can approve his
  own manual tag release.

  **Exact repository policy with proved flow effects:** new
  `.github/repository-hardening.json` names the public repository, owner,
  GitHub Actions App ID `15368`, merge policy, free security features,
  environments, and active `main-release-safety` ruleset. The ruleset blocks
  deletion, force pushes, merge commits, and ordinary direct updates; requires
  an up-to-date pull request, resolved threads, squash/rebase, and both exact CI
  checks; and requires zero approvals for the solo repository. Only GitHub
  Actions App ID `15368` has an `always` bypass, preserving the audited atomic
  release commit/tag push. Dependabot gets no bypass and follows the checked-PR
  route. Required commit signatures remain deliberately absent because the
  current writer creates an unsigned commit/tag and a new long-lived signing
  key would add cost and recovery risk.

  New dependency-free `scripts/repository-hardening.mjs` validates and models
  that policy locally, audits GitHub read-only, and has an idempotent apply path
  guarded by the literal repository confirmation. Apply refuses an unowned
  active ruleset or environment ref policy, requires both successful CI checks
  on remote `main`, and activates the ruleset last. Six modeled outcomes prove
  that Kyle direct/force/delete operations are blocked, Kyle's and Dependabot's
  checked pull requests remain mergeable, and the GitHub Actions release push
  remains allowed. The live read-only audit named exactly the expected
  unapplied drift and did not falsely flag the already-correct Actions default
  or Dependabot-alert state.

  Free public-repository secret scanning and push protection, Dependabot
  alerts/security updates, and private vulnerability reporting are prepared.
  GitHub's current eligibility documentation limits non-provider secret
  patterns and validity checks to eligible organization-owned repositories
  with paid Secret Protection, so the policy records both as unavailable on
  this free user-owned repository and never sends misleading API mutations for
  them.

  **Recovery ownership:** new `RELEASE-RECOVERY.md` separates SHA manifests,
  GitHub/Sigstore provenance, and operating-system signing. Provenance uses a
  short-lived GitHub OIDC identity, so there is no long-lived provenance key to
  buy or back up. Direct Windows/Linux downloads remain unsigned; no Windows
  certificate, signing private key, or Microsoft Store identity is claimed.
  The guide records same-run seven-day artifact retry, partial draft/public
  states, forward-only higher-version recovery, ruleset break-glass boundaries,
  the safe-disabled repository variable, upstream-only npm ownership, and the
  private GitHub passkey/security-key, offline recovery-code, recovery-email,
  and notification preparations Kyle must later verify without sharing secret
  material.

  **Verification:** all four YAML files parse; the local hardening validation
  and six merge-flow simulations pass; focused action/CI/workflow/manifest/
  coordinator/hardening tests pass; and the complete suite passes **123/123**.
  `npm ls --all` resolves with only expected absent-platform optional packages,
  `npm audit --audit-level=moderate` reports zero vulnerabilities, and all 376
  registry signatures plus 56 attestations verify. `package.json` and
  `package-lock.json` retain their Step 5.3 SHA-256 values
  `006c0c4d08de033f5833472fba0a0e1f4b7a185899a4dd34ed44c7f07397aa39`
  and `2f9225219fdeac7b5bbc058a18b6b206ce411092f968225cfa2d1018e1b4028c`;
  no dependency was added. `git diff --check` is clean.

  **Implemented boundary:** executable changes modify the two release
  workflows and the release-contract/coordinator policy modules, and create the
  CI workflow, Dependabot policy, exact hardening data, and guarded reconciler.
  Test changes extend release/workflow/coordinator fixtures and create focused
  pin, CI, Dependabot, and repository-policy protection. Documentation changes
  update `README.md`/this plan and create the recovery guide. Desktop runtime,
  updater UI/behavior, daemon behavior, packaging targets, dependencies, and
  installed clients are behaviorally unchanged by this Step.

  **Limits kept explicit:** no workflow from this worktree has run on GitHub;
  no Linux/Windows package, Actions artifact, or GitHub attestation was created
  here; and GitHub has not yet observed the new CI check identities. No
  environment, ruleset, merge setting, security feature, variable, ref, tag,
  draft, release, or public feed entry was changed remotely. Kyle's private
  account-recovery readiness remains unverified. External application waits
  until the non-publishing rehearsal demonstrates the committed live workflow;
  that is Step 5.5, not an unclaimed result of this Step.
- [x] **Step 5.5 — rehearse without publishing.** Exercise no-update,
  one-update, rapid-two-update, failed-Linux, failed-Windows, stale-main,
  duplicate-run, and retry scenarios. Verify that the workflow creates no
  public tag/release during rehearsal and that the proposed release contains
  the exact proven Shell package.

  **Completed 2026-08-13 — deterministic state-machine and hosted native
  rehearsal:** the verified starting point was local and remote `main` at
  `bee5bd51b127c086114a6833004b34d8c04faf39`, exactly the two existing tags
  `v0.1.0` and `v0.1.1`, exactly the two corresponding public releases, and no
  repository variables. The npm registry reported `mirafold@0.3.7` as latest.
  A live `shell-intake prepare` probe selected that same version and integrity
  (`sha512-gAlbgcHbcpXedv0yJCGpXLoh2XGs2ym+A3oEB4jGhlpxn1P1Ea9W8OWqpq326Q+PgSKWPUP46RV2/SeC+Jw7Qg==`),
  returned `changed=false`, and left the then-current `package.json` and
  `package-lock.json` byte-identical. Thus the rehearsal began from a proven
  no-update state rather than manufacturing a candidate.

  `scripts/release-rehearsal.mjs` and `npm run release:rehearse` now run named,
  isolated Node test cases and fail if any requested scenario has no matching
  proof. The final report passed all ten checks: no-update (one assertion),
  one-update (one), rapid-two-update (two), failed-Linux (two), failed-Windows
  (two), stale-main (one), duplicate-run (one), retry (one), no-publication
  (two), and exact-Shell-identity (three). In particular, two rapid candidates
  from the same base cannot overwrite one Desktop patch; an outdated queued
  candidate fails closed after `main` advances, while a fresh retry from the
  new `main` can select the following patch. Any failed native leg blocks both
  provenance and publication, duplicate delivery converges on the same state,
  and manual dispatch cannot enter the publisher.

  The implementation was committed only to the isolated public branch
  `step-5-5-release-rehearsal`; `main` was not moved. Three non-publishing
  `workflow_dispatch` runs then exercised GitHub's actual Windows and Linux
  runners:

  - [run 31765226537](https://github.com/mirafold/mirafold-desktop/actions/runs/31765226537)
    proved failed-Windows gating. Windows exposed a test-only POSIX path
    expectation at `test/packaged-smoke.test.js:78`; production
    `packagedPaths()` had returned the correct Windows-native path. Linux still
    completed because the matrix has `fail-fast: false`, while provenance and
    publication stayed skipped. The correction uses `path.resolve()` and
    `path.join()` in the test; no packaged-runtime behavior changed.
  - [run 31765358019](https://github.com/mirafold/mirafold-desktop/actions/runs/31765358019)
    then completed both native legs. Each packaged smoke reported Desktop
    `0.1.1`, Shell `0.3.7`, the bundled daemon entry
    `node_modules/mirafold/dist-server/index.js`, and successful loading of
    both `node-pty` and `@parcel/watcher`; both platform artifact contracts and
    SHA-256 manifests passed. GitHub stored Linux artifact `9206290890`
    (`sha256:28d35f5a39d344b24496a8e4f72237f67d568f526c8baa9661794f02bc044756`)
    and Windows artifact `9206155664`
    (`sha256:87b5319fb0c44fac76aa58e2a3dad7acc516a46f4c5c155dbd8bd322509aae11`).
    The provenance job validated their combined contract and created
    [attestation 40648219](https://github.com/mirafold/mirafold-desktop/attestations/40648219)
    for exactly nine subjects: both manifests, both updater metadata files,
    AppImage, tarball, Debian package, NSIS installer, and NSIS blockmap. Its
    subject digests were respectively
    `01d02792b75bf48869844a461853d7b71cb1321bdda9a72f30a58df3920b2b9b`,
    `89ac6385756aba27716fbca21cb306fb679285002d565d6b99e7c4dd33012228`,
    `786e2cd6b109433163a029e8ccf8161f147c1c42e5147e70230f19ca73e829f5`,
    `a0622e8595f93623be6dce746925014c80c1e77bb7aeb12c166f1491cc8bc062`,
    `c688d51fb2ca554115791329657ce0b3561d6df4f315692717727fb1c2f9257c`,
    `cb7cf74e1b726d43e943a09d04a8e67c3e124355ca672fa58b9e4a2077ecb03c`,
    `c3580a2864bda7db34ddfb08b9e7918e2a4f220d89dde2a693ae959254a24e69`,
    `a5013ce84ec02c48df654cb32aa096170c271e31c9b8008599d03bc0d57deeda`,
    and
    `36270e8ab477b228ebb0c1dc8c4cbd05305061c798ac381e1adcff7643faf0c6`.
  - [run 31765808934](https://github.com/mirafold/mirafold-desktop/actions/runs/31765808934)
    exercised the final committed workflow's explicit `fail_platform=linux`
    input. Linux failed before dependency installation; Windows independently
    passed tests, packaging, packaged smoke, contracts, and artifact upload.
    GitHub stored Windows artifact `9206310136`
    (`sha256:aec846e67f758e731256a2d59210b9470908ac41273518071511325a76b85406`),
    while both provenance and publication were skipped.

  **No-release proof:** a final live snapshot still found remote `main` at
  `bee5bd51b127c086114a6833004b34d8c04faf39`, only tags `v0.1.0`/`v0.1.1`,
  only release IDs `363923829`/`364215203` with their original eight assets and
  digests, and zero repository variables. Therefore no tag, GitHub Release, or
  installed-client update feed changed. The rehearsal intentionally did create
  a public branch, Actions runs and temporary Actions artifacts, plus the
  successful run's public provenance attestation; those are evidence, not
  release publication.

  **Actual change boundary:** executable tooling adds
  `scripts/release-rehearsal.mjs`, exposes it as the dependency-free
  `release:rehearse` package script, and adds a manual-only `fail_platform`
  choice to `.github/workflows/release.yml`; push/tag behavior is unchanged.
  Tests add the rehearsal mapping, rapid concurrency/retry and failed-leg
  coverage, manual publisher/failure-injection contracts, and the native-path
  expectation correction. Documentation changes explain the local and hosted
  rehearsal in `README.md` and record this evidence here. Desktop runtime,
  updater behavior, daemon behavior, packaging targets, the exact Shell
  `0.3.7` dependency, and the lockfile are behaviorally unchanged by this
  Step. `package.json` changed only by the new script and now hashes to
  `102c68f5a05694a2f99a9c9263a4620bcc5f70a64841c0a1622160c95a28e089`;
  `package-lock.json` remains
  `2f9225219fdeac7b5bbc058a18b6b206ce411092f968225cfa2d1018e1b4028c`.
  No package was added.

  **Final verification and limits:** all 131 tests pass, the ten-check
  rehearsal passes, all scripts parse, all four repository YAML files parse,
  `npm ls --all` is valid apart from expected absent-platform optional
  packages, `npm audit --audit-level=moderate` reports zero vulnerabilities,
  all 376 installed packages have verified registry signatures, 56 have
  verified attestations, and `git diff --check` passes. The automated
  Shell-intake workflow itself could not run from this branch because GitHub
  dispatches only workflows present on default `main`; no newer real Shell
  publication existed to consume. The writer token/API path remains
  deliberately unexercised because `MIRAFOLD_AUTOMATED_RELEASES` is absent.
  No branch was merged, no repository setting was applied, no installed client
  was updated, and no tag/draft/release was created. Step 6.1 owns deeper
  Windows daemon and installer execution; Step 7.3 owns the explicitly
  approved bridge release, and Step 7.4 owns the first real newer-Shell
  production validation.

### Phase 6 — Windows proof and the free Microsoft Store channel

- [ ] **Step 6.1 — add Windows packaged smoke coverage.** On the Windows CI
  runner, verify the packaged application can resolve and load both native
  modules, start the real bundled daemon far enough to validate its URL
  contract, close it without descendants, and silently install/uninstall the
  per-user NSIS candidate where runner capabilities permit. Keep human-only
  behavior explicitly separate.
- [ ] **Step 6.2 — test direct-download Windows with a human.** Refresh
  `WINDOWS-TESTING.md` for the bridge/updater and walk Kyle through recruiting a
  Windows tester one action at a time. Observe SmartScreen, installation,
  folder selection, agent response, ConPTY command, filesystem watching,
  automatic update, restart, and zero leftover processes. No public launch
  claim precedes this evidence.
- [ ] **Step 6.3 — establish the free Store identity.** Walk Kyle one action at
  a time through Microsoft's free individual developer registration, identity
  verification, name reservation, and retrieval of the real Partner Center
  package identity. Government ID/selfie actions remain Kyle's; no identity or
  secret is pasted into chat or stored in this repository.
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

- [ ] **Step 7.1 — correct all distribution documentation.** Replace inaccurate
  SmartScreen/certificate and macOS Gatekeeper claims; document exact update
  behavior per package, Desktop-versus-Shell versions, the one-time bridge,
  unsigned direct-download trust, free Store signing, failure/recovery, and
  support boundaries. Keep executable, test, and documentation diffs reported
  separately.
- [ ] **Step 7.2 — perform final ship-readiness verification.** Re-run unit,
  workflow, dependency, signature/provenance, packaged Linux, CI Windows, update
  transition, and security-boundary checks. Audit the final dependency and
  artifact contents, compare the implementation with this approved boundary,
  and list every remaining unverified real-world claim.
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

## Status

**Phase 1 — the app itself: DONE (2026-08-02).**

Electron main process, folder picker, daemon lifecycle, crash recovery, menu,
Linux packaging. Verified end to end on Linux in both a dev checkout and the
packaged build:

- daemon boots under `ELECTRON_RUN_AS_NODE` and reports Node 24.18.0 (above
  `mirafold`'s Node ≥22 floor)
- the real Mirafold UI loads in the window, in the picked folder
- `node-pty` runs a real pseudo-terminal (a `!` bang command returned output)
- `@parcel/watcher` fires (a file created externally appeared in the tree
  unprompted, with its git status)
- clean quit leaves **zero** orphans — daemon and its pty grandchildren all die
- `kill -9` on the daemon leaves the app **alive** with a crash dialog, which is
  the behavior the child-process architecture exists to produce

Both native-module checks were repeated against the packaged AppImage payload,
not just the dev checkout.

**Phase 2 — release: DONE. `v0.1.1` is the current release (2026-08-03).**

Four installers on GitHub Releases: `mirafold-desktop_0.1.1_amd64.deb` (236 MB),
`mirafold-desktop-0.1.1.tar.gz` (295 MB), `Mirafold-0.1.1.AppImage` (312 MB),
`Mirafold-Setup-0.1.1.exe` (230 MB). Release run `30814902927`, all three jobs
green. **Anonymous download verified** — an unauthenticated request returned
`200` and the payload begins `MZ`, a real Windows executable, so a tester needs
no GitHub account. That is why a tag is cut at all: GitHub requires a login to
download *workflow-run* artifacts even from a public repo, so without a release
there is no way to hand anyone the file.

`v0.1.0` (2026-08-02, run `30772737027`) is superseded and should not be handed
to anyone — it predates every fix below.

**Not announced anywhere, and nothing goes on mirafold.com** (Kyle,
2026-08-02) until it has been tested. The repo is public and therefore
indexable, but nothing links to it.

### What v0.1.1 contains that v0.1.0 did not

A full-project **bughunt** found and fixed three bugs: a chatty login-shell
profile corrupted the first PATH entry in `login-env.js` (reproduced; even
Ubuntu's stock bashrc triggers it); boots weren't serialized, so File → Open
Folder or a quit during a slow boot could orphan a daemon past quit and raise a
spurious error dialog; and a daemon dying right after reporting its URL stacked
two error dialogs. A failed boot also killed only the daemon, orphaning agent
CLIs it had already spawned — now a process-tree kill on both paths.

A **security audit** found and fixed five things. Clean on what matters most:
no secrets anywhere in git history, zero dependency vulnerabilities, all 399
lockfile entries hashed and registry-sourced, Electron 43.2.0 (latest, Chromium
150), and the packaged payload carries only production dependencies — no dev
tooling, tests, or planning docs. Fixed: the CI build job inherited a
repo-**write** token while running ~400 packages' install scripts (now
read-only, `persist-credentials: false`; the release job alone writes); the
`will-navigate` guard permitted every `file://` URL (Chromium blocked it
independently — verified in a real window — so nothing was exploitable, but the
rule is ours now, in `src/navigation.js`); the daemon's per-launch auth token
was mirrored to app stdout and into the crash dialog; and the crash buffer
capped line count but not line length. `SECURITY.md` now gives a private
reporting channel and records the deliberate decisions, so future audits don't
re-litigate unsigned builds, the no-bridge window, or the size.

**The repo now has a test suite** (`npm test` — node's built-in runner, zero
added dependencies), 14 tests pinning every bug above, and CI runs it on both
platforms before packaging. It has already earned itself: it failed the first
v0.1.1 build attempt (run `30814632008`) on two platform-dependent fixtures of
its own — a CRLF checkout on Windows, and a hardcoded POSIX path — before
anything was packaged. **Write tests that run on Windows too**: git converts
line endings on checkout there, and `fileURLToPath` returns backslashes.

*Pre-release state (rehearsal run, Windows-payload inspection, the
hold-the-tag decision — since superseded by the v0.1.0 release above) →
archived in PLAN-ARCHIVE.md.*

## Decided, don't re-open

| decision | why |
| --- | --- |
| Daemon is a **child process**, not imported | crash isolation, event-loop isolation, per-folder cwd (`src/daemon.js` header) |
| **No preload / IPC / nodeIntegration** | keeps Mirafold's browser security model true as written |
| **asar off** | a partially-unpacked archive resolves the daemon but not its dependencies; the failure would surface only when packaged, on Windows, where it can't be debugged |
| **Linux + Windows only, unsigned** | both work unsigned; macOS does not |
| **No macOS** | Gatekeeper refuses quarantined unsigned apps outright — an unsigned `.dmg` is useless to a downloader, not merely scary |
| `.deb` + `.tar.gz` + `.AppImage` | AppImage alone is not enough: it needs `libfuse2`, absent by default on Ubuntu 22.04+ and most current distros (reproduced) |
| **Linux updater follows installed form** | AppImage can replace its user-owned file; Debian requests system authorization through the available elevation helper; a tar extraction has no safe universal self-replacement path and therefore receives a notice plus the fixed official download URL |
| **npm**, not yarn | electron-builder assumes npm layouts; yarn 1 hoisting fights platform-specific optional deps, which is exactly how the native modules ship |
| **Repo stays public** (considered private 2026-08-05, rejected) | a shipped Electron app is trivially unpacked, so repo privacy protects nothing; no credential can ever live client-side; any paid gating is server-side (accounts + credits), so private had no benefit left |

## Facts about the world that no repo can observe

- **Kyle has a Mac** (stated 2026-08-02). This is the reason macOS is a
  *deferred cost decision* rather than an untestable one: when the $99/yr Apple
  Developer membership is bought, he can verify the real download-and-open
  experience himself, including the launched-from-Finder `PATH` problem that
  `src/login-env.js` exists to solve and that only reproduces on real hardware.
- **Nobody on this project has a Windows machine.** The Windows artifact is
  CI-built and inspected, never launched.
- **macOS is deferred until Mirafold "takes off"** (Kyle's words, 2026-08-02) —
  a revenue trigger, not a technical blocker.

## Next

1. **Get the Windows build tested by a human — the top priority.** Until a real
   person installs it, the Windows artifact is "CI produced a file," and nothing
   should imply more. What to have them check, in order: installs past
   SmartScreen · folder picker works · a prompt gets a response · a `!` command
   works (ConPTY, the most platform-specific path) · the file tree updates on an
   external edit · **after quitting, Task Manager shows no leftover `mirafold`
   processes** (the `taskkill /T /F` path, written but never observed).
   **Tester instructions exist: `WINDOWS-TESTING.md`** (added 2026-08-03, now
   pointing at v0.1.1) — a self-contained checklist covering all of the above
   plus the download-warning click-throughs and the API-key path; send a tester
   that one file and nothing else is needed. Its download URL was verified
   anonymous-accessible (HTTP 200, `MZ` header, no auth) after the v0.1.1
   release published.
2. **Then, and only then, announce — and the announcement is now a launch of
   its own (Kyle, 2026-08-05).** The desktop app launches separately from the
   core product's 2026-07-31 launch, and its launch waits on the paid
   metered-access tier (accounts + a flat subscription with a capped usage
   allowance, so non-technical users never touch an API key — built
   server-side and upstream, nothing in this repo), because zero-setup convenience is the story the launch tells.
   Requires Kyle's explicit go. A download page on mirafold.com lives in the
   site repo, not here.
3. **Push the held `genui-shell` commit.** `6d31c39` corrects `POST-RELEASE.md`
   there, but that file ships in the **public** `mirafold/mirafold` repo, so
   pushing it announces this app's existence. Held deliberately; push it when
   the announcement happens.

## Known gaps, not yet scheduled

- **Credential entry has no GUI — PARKED (Kyle, 2026-08-03), not scheduled.**
  The onboarding screen tells you to set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`,
  which assumes a terminal. Users who already have Claude Code, Codex, or Gemini
  CLI logged in are fine — their existing config is picked up, and they are the
  target audience — but a brand-new user with only an API key has to hand-write
  a `.env` in the project folder, per folder, and creating a dotfile is worst on
  Windows (which is why `WINDOWS-TESTING.md` walks a tester through Notepad's
  quoted "Save As"). **Reasons it stays parked, so this isn't re-derived:** (1)
  it is product behavior — a settings screen is UI plus storage plus how the
  daemon gets its environment, so it belongs in `mirafold` upstream, and
  building it here would break this repo's no-product rule; (2) accepting a
  credential means owning it — storage, encryption at rest, log/crash-report
  leakage, uninstall — and this repo currently handles **zero** credentials, a
  property the audit verified and worth keeping; (3) zero users have hit it.
  **Trigger to revisit is evidence, not a date:** a tester stalling on it, or
  the marketing site starting to pitch people who have only an API key.
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
- **Windows process-tree teardown is written but untested.** `taskkill /T /F` is
  the right call; nobody has watched it work. It is now reached from two paths
  (normal quit and failed boot), both through one `killTree()`.
- **A hard kill of the app orphans the daemon.** The daemon is spawned
  `detached` so its process group can be signalled, which by construction means
  it survives a `SIGKILL` of the app. Normal quit and window close are handled.
