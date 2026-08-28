# Mirafold Desktop

Mirafold in its own window — no terminal, no Node, no npm.

[Mirafold](https://mirafold.com) is a faithful browser re-skin of the terminal
coding agent you already use (Claude Code, Codex, Gemini CLI) with generative UI
layered on top. It normally installs with `npm i -g mirafold` and runs from a
terminal. This repo wraps that same software in a desktop application so that
installing it is a download and a double-click.

**Download:** [Releases](https://github.com/mirafold/mirafold-desktop/releases)
— **Linux** (`.deb`, `.tar.gz`, `.AppImage`) is the supported release.
**Windows** (`.exe`) is a **beta**: the installer is unsigned, so SmartScreen
warns on it, and it has not yet had the real-machine testing Linux has.
**macOS is not available** — there is no Mac package, and none is planned
until the project can carry Apple's signing and notarization requirements
(see *Signing status* below).

**What you need:** a coding agent the bundled Mirafold Shell can use — today
that means a local Codex/ChatGPT login, or an API key already present in your
normal environment. The app has no credential-entry screen and never asks you
to send credentials anywhere; if no live agent path is available, demo mode
shows the interface with scripted replies.

## Install on Ubuntu with APT

Ubuntu 24.04 on `amd64` is the tested APT target. Install Mirafold's repository
identity once, then install the application by package name:

```
curl --fail --location --output /tmp/mirafold-archive-keyring_1.0_all.deb https://github.com/mirafold/mirafold-desktop/releases/latest/download/mirafold-archive-keyring_1.0_all.deb
sudo apt install /tmp/mirafold-archive-keyring_1.0_all.deb
sudo apt update
sudo apt install mirafold-desktop
```

The small first package installs only Mirafold's public archive key, a deb822
APT source restricted to that key, and a root-owned marker that tells the app
APT owns its updates. Its public fingerprint is
`30C663842E3433E94B793B79AD4514FE0C3F6F0C`. The source points at the latest
stable GitHub Release, whose signed `Release` metadata binds the package index
and the exact Desktop `.deb`. After setup, normal `apt upgrade` and Ubuntu's
software updater can deliver later Mirafold versions. The Releases page remains
the direct-download path for AppImage, tar, Windows, and a standalone `.deb`.

## How updates work

The public `v0.1.1` build predates the updater, so it cannot discover a newer
release. Install `v0.2.0` or later manually once if you use a direct-download
form. Those forms check for a newer Desktop release after startup and through
**Help → Check for Updates…**. An APT-managed installation instead leaves all
checks and installation to APT and says **Updates managed by APT** in Help. A
Desktop release carries its own exact Mirafold Shell version; the Help menu
shows both versions separately. It never installs a different Shell package
from npm on an end user's machine.

| installed form | when a newer release exists |
| --- | --- |
| direct Windows `.exe` | Downloads and verifies the complete NSIS installer, asks before restarting, stops the complete daemon/agent process tree, then opens the visible per-user installer and requests that the new version reopen. Mirafold waits for Windows to acknowledge that launch; a launch failure restores the working session without quitting it. The automated Windows probe proves a silent current-user install with no machine-wide registration; the visible installer and elevation behavior still await the human protocol below. |
| `.AppImage` | Downloads and verifies the new AppImage, asks before restarting, and stops the complete daemon/agent process tree. It stages the replacement beside its destination, retains the current executable until the new file launches, and rolls a custom-filename replacement back if launch fails. No administrator access is needed. |
| APT-installed `.deb` | APT verifies the archive signature and package hashes, then owns installation and updates like any other repository package. Mirafold's private updater is disabled for this form. |
| standalone downloaded `.deb` | Downloads and verifies the new Debian package, asks before restarting, stops the complete daemon/agent process tree, then requests administrator authorization through the available system elevation helper before running `dpkg -i`. The local probe selected `pkexec`; the exact authorization dialog depends on the Linux desktop. |
| extracted `.tar.gz` | Shows a native notice and opens the official HTTPS Releases page. It never downloads an installer or changes the extracted tree; close Mirafold and replace it manually. |
| Microsoft Store package | Not offered yet. Once one exists, it will use the Store's update channel; the app's GitHub updater is disabled for that package. |

Choosing **Later** never installs on ordinary quit. Mirafold also refuses
lower-numbered Desktop versions. If a release must be recovered, maintainers
rebuild the last known-good source as a new, higher Desktop version so every
user moves forward through the same verified path. A failed background check
does not interrupt a working session; a manual check reports the failure. An
installer is not started unless Mirafold confirms that its local processes
stopped, and an installer-start failure attempts to restore the current
session. On Linux, that proof includes pseudo-terminal children that create
their own sessions and process groups rather than remaining in the daemon's
group.

The exact Windows checks that automation cannot perform are in
[WINDOWS-TESTING.md](WINDOWS-TESTING.md). The separate free Store path, its
account boundary, and everything that remains unimplemented are recorded in
[MICROSOFT-STORE.md](MICROSOFT-STORE.md).

## What this is, precisely

A thin Electron shell around the **published `mirafold` npm package**. It adds a
window, a folder picker, a menu, and process lifecycle management. It contains
no product logic, no UI, and no copy of the server — those all live in
[`mirafold/mirafold`](https://github.com/mirafold/mirafold) and are consumed
here as an ordinary dependency, the same artifact npm users install.

```
┌─ Electron main process ─────────────────────┐
│  folder picker · menu · crash dialog        │
│                                             │
│  spawns ──► mirafold daemon (child process) │
│             ├─ agent CLIs (pty)             │
│             └─ HTTP + WebSocket on loopback │
│                        ▲                    │
│  BrowserWindow ────────┘ loads its URL      │
└─────────────────────────────────────────────┘
```

### The daemon is a separate process, on purpose

It would be possible to import the daemon into Electron's main process. It runs
as a child instead, for three reasons:

1. **Crash isolation.** The daemon installs process-wide crash handlers that end
   in `process.exit(1)`. In-process, that exit would take the whole app down
   mid-keystroke with nothing on screen. As a child, it's an exit code the app
   catches, reports with the daemon's own stderr, and offers to restart from.
2. **Event-loop isolation.** Pseudo-terminal reads, agent streaming, filesystem
   watching and transcript serialization are constant work. Sharing one event
   loop with window management would let a long synchronous chunk freeze the UI.
3. **Per-folder working directories.** A child process takes its `cwd` from
   `spawn()`. An in-process daemon would read `process.cwd()`, which is global
   and effectively one-shot.

The bootstrap is started with **Electron's own binary** under
`ELECTRON_RUN_AS_NODE=1`, which makes that one process behave as a plain Node
interpreter. It removes the switch before importing Mirafold Shell, so Shell
and agent commands inherit an ordinary environment. That is what lets this app
run on a machine with no separately installed Node.js without changing the
meaning of an Electron executable an agent might launch.

On Linux, the bootstrap records each pseudo-terminal's PID and kernel start
time synchronously when it is created; the app corroborates those identities
against `/proc` before signalling them. On Windows, a PowerShell wrapper joins
a kill-on-close Job Object before starting the daemon, so a daemon crash also
closes every descendant. Ordinary quit waits through bounded graceful and
forced cleanup before Electron exits.

### There is no bridge into the page

No preload script, no IPC, no Node access in the renderer. The window loads the
daemon's `http://127.0.0.1:…` page as an ordinary web page, exactly as a browser
would — so Mirafold's own security model (its Content-Security-Policy, its
per-launch auth token, its Origin guard) remains true here without re-auditing.
The native pieces a desktop app owes you live in the main process, where they
need no bridge.

## Files

| file | what it does |
| --- | --- |
| `src/main.js` | app lifecycle, window, menu, folder picker, crash dialog |
| `src/app-lifecycle.js` | hold ordinary Electron quit until asynchronous cleanup finishes |
| `src/daemon-bootstrap.cjs` | enter packaged Node mode, scrub it, and register Linux pseudo-terminals |
| `src/daemon.js` | spawn the daemon as a child, read its URL, own its lifecycle |
| `src/daemon-output.js` | credential-redacting, memory-bounded handling of the daemon's output |
| `src/process-tree.js` | track and stop the daemon's whole process tree, and prove it is gone |
| `src/windows-daemon-job.ps1` | own the Windows daemon tree with a kill-on-close Job Object |
| `src/navigation.js` | what the window is allowed to load, and what goes to the browser |
| `src/permissions.js` | deny Chromium permissions except notifications from the active daemon's main frame |
| `src/platform-updaters.js` | atomic AppImage replacement and acknowledged NSIS launch |
| `src/updater.js` | update policy for APT, direct installers, Store packages, and Linux tar archives |
| `src/login-env.js` | recover the login shell's `PATH` so agent CLIs are findable |
| `src/state.js` | remember the last-opened folder |
| `electron-builder.yml` | packaging targets, with the reasoning as comments |

## Development

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) (DCO sign-off, branch
from `next`) and releases follow [docs/RELEASING.md](docs/RELEASING.md) —
`main` is the production mirror and only advances at release time.

```
npm install
npx install-electron        # Electron 43 has no postinstall; fetch the runtime
npm start
```

On a Linux dev checkout, Electron's `chrome-sandbox` helper isn't installed with
the root ownership it needs, and the app aborts. Use `npm run start:nosandbox`
while developing — packaged builds install the sandbox correctly and don't need
it.

Tests:

```
npm test
```

Node's built-in runner, no test dependencies. They pin process teardown across
separate pseudo-terminal groups, the asynchronous quit gate, non-destructive
platform-installer failures, `PATH` recovery, navigation rules, and the
window's actual security wiring (that the real window consults those rules on
every navigation, redirect, popup, and permission request) — the seams where
this app's real risk lives. CI runs them on Linux and Windows before
packaging anything. Write them to pass on both: a Windows checkout converts
line endings to CRLF, and `fileURLToPath` returns backslashes there.

### Preparing a Shell release

`npm run release:prepare -- VERSION` accepts the exact stable version already
observed at npm's `latest` tag. It requires the repository's declared npm
version, checks the fixed public registry before and after lock generation,
pins Mirafold exactly, and advances the independent Desktop patch once. Lock
generation runs in a disposable directory with dependency scripts disabled;
any semantic change outside Mirafold's old/new dependency closure aborts before
the repository files are written. Running it again for the current Shell is a
byte-for-byte no-op.

### Automated Shell releases

`.github/workflows/shell-intake.yml` checks npm `latest` at minutes 17 and 47
of every hour and can also be run manually from the canonical repository's
`main` branch. Runs are serialized; if several Shell versions appear while one
run is active, the newest pending observation replaces the older pending one.

When the exact Shell pin is already current, intake stops after the verified
byte-level no-op. For a newer version it prepares the package/lock pair with
lifecycle scripts disabled, asks npm to verify every registry signature and
provenance attestation, and then applies an additional Mirafold policy: the
package bytes must come from `mirafold/mirafold`, the matching `vVERSION` tag,
and `.github/workflows/release.yml` on a GitHub-hosted runner. Only the reviewed
`package.json`, `package-lock.json`, and compact `shell-intake.json` evidence
cross into fresh read-only test and build jobs. Git attributes force the two
reviewed manifests to LF on every checkout, preserving the byte-exact baseline
across Linux and Windows. The native Linux and Windows
runners independently apply that exact pair, install with lifecycle scripts
disabled, validate the dependency tree, advisories, registry signatures, and
attestations, run the full suite, and build their native installers. Each
packaged Electron runtime must then resolve the real bundled daemon, load both
native wrappers, start the daemon through Desktop's production process owner,
reach its authenticated IPv4-loopback URL, and prove the complete process tree
is gone afterward before its updater artifacts are retained. The Windows leg
also silently installs the actual NSIS candidate in explicit current-user mode,
proves it registered only under that user, repeats the runtime/daemon smoke from
the installed bytes, silently uninstalls it, and proves its files and registry
entry are gone.

The separate Linux update probe uses the real bundled daemon and node-pty. It
starts a heartbeat command inside a pseudo-terminal, performs the verified
AppImage and Debian update lifecycles against a loopback feed, and refuses the
install if that heartbeat can still run after Desktop's shutdown proof.

After every read-only gate succeeds, a separate job reconstructs the same
candidate without installing dependencies. It permits only the reviewed
package/lock change, advances `main` and one annotated Desktop tag through one
atomic Git push, creates a draft release, uploads all 17 native and signed APT
files, and verifies the remote title, notes, names, sizes, and
GitHub-calculated SHA-256 digests before the release can become public and
`latest`.
Before that writer can run, an isolated short-lived GitHub identity creates
SLSA build provenance for the exact 17 digests; dependency and build jobs
never receive its OpenID Connect or attestation permissions. A stale `main`, a
conflicting tag, or a different candidate fails closed. A retry recognizes the
exact prior commit, tag, complete draft, or complete public release and resumes
without creating a second Desktop version. For an interrupted writer, re-run
the failed jobs in the same workflow run so it retains the original commit and
artifacts.

Publication is intentionally dormant: the repository Actions variable
`MIRAFOLD_AUTOMATED_RELEASES` must equal the literal value `enabled` before the
write job can run. Keep it absent through the first signed APT release and its
non-publishing rehearsal. Once that gate is deliberately enabled, ordinary
Shell releases require no Desktop source edit, version command, tag, installer
build, or GitHub Release action from a maintainer.

`npm run update:probe:linux OLD_APPIMAGE NEW_RELEASE_DIR` is the local-only,
disposable proof of the real Linux update paths. It serves a freshly built
release over IPv4 loopback only, drives electron-updater's real metadata,
SHA-512, download, and platform-installer code for AppImage, `.deb` and the
tar notice, starts the real bundled daemon and proves its URL is unreachable
before any installer runs, and touches nothing outside a temporary directory
(the Debian privilege command is captured, not executed). Its `--bridge
BRIDGE_DIR REGRESSED_DIR RECOVERY_DIR` form rehearses the one-time updater
bridge, checksum rejection, and forward-only recovery. It is not part of `npm
test` because it needs two packaged versions and several minutes; it is
what proved the per-form Linux update table above.

`npm run release:rehearse` runs the deterministic, local, non-networked release
state-machine rehearsal. It covers no update, one update, rapid consecutive
updates, either native build failing, stale `main`, a duplicate run, every safe
retry state, publication isolation, and the exact Shell identity carried from
reviewed intake into the proposed native package. Each scenario must prove its
named evidence test really ran — Node counts a test file itself as one passing
test, so a bare pass count would accept a renamed or deleted scenario test. A
manual dispatch of the `Release` workflow from canonical `main` is the separate
native Linux/Windows rehearsal: it builds, smoke-checks, verifies, retains,
signs with the production archive identity, and attests the 17 files, while the
event gate keeps its only `contents: write` publication job skipped. The
signer uses the existing `automated-release` environment, whose live branch
policy admits only `main`; a real `v*` tag instead uses the reviewer-protected
`manual-release` environment. Its build jobs use the same script-free pinned
npm toolchain and signature/advisory gates as Shell intake, so the manual tag
path and the automated path package identical, registry-verified bytes. Its
manual form also
accepts `fail_platform=linux` or `fail_platform=windows`; the selected native
leg fails before dependency code, proving that either platform failure prevents
provenance and publication while the other matrix leg is still allowed to run.

The Windows runner cannot truthfully stand in for a person. Its silent NSIS
probe does not claim anything about SmartScreen, the visible install wizard,
interactive destination selection, Start-menu launch, folder selection, or the
full agent/ConPTY/file-watching experience. Those remain the real-Windows human
checks in [WINDOWS-TESTING.md](WINDOWS-TESTING.md).

Every workflow action is pinned to a reviewed commit SHA. The committed CI
policy defines stable `test (linux)` and `test (windows)` checks for `main` and
pull requests, while the Dependabot policy requests weekly review of npm
dependencies and those action pins. The exact proposed repository rules,
release environments, free security settings, account responsibilities, and
break-glass recovery procedure are in
[RELEASE-RECOVERY.md](RELEASE-RECOVERY.md). The local reconciler validates and
audits those settings and refuses to activate the branch ruleset before both
named CI checks have succeeded on `main`.

Building installers:

```
npm run pack          # unpacked directory, fastest check that packaging works
npm run dist:linux    # .deb, .tar.gz, .AppImage
npm run dist:win      # NSIS installer (must run ON Windows — see below)
```

**Windows packages must be built on Windows.** Both native modules ship as
platform-specific optional dependencies (`@lydell/node-pty-win32-x64`,
`@parcel/watcher-win32-x64`) that npm on Linux will not download; a
cross-built package would install and then fail on the first terminal pane.
CI does this on a `windows-latest` runner.

### Why the app is large

The Claude and Codex SDKs each bundle a complete agent binary (~260 MB and
~280 MB). They are what make the app work without a separately installed CLI,
and they cannot be dropped without changing the upstream `mirafold` package.
That is the whole of the download size; the app's own code is a few hundred
kilobytes.

### Native modules need no rebuild

Both `@lydell/node-pty` and `@parcel/watcher` are **Node-API (N-API)** addons —
verified by symbol inspection of the compiled binaries, which carry `napi_*`
symbols and no `v8::` ones. N-API is ABI-stable across runtimes, so they load
unmodified inside Electron. There is no `electron-rebuild` step, and adding one
would be a mistake.

## Security

Report anything exploitable privately to <security@mirafold.com> rather than in
a public issue — see [SECURITY.md](SECURITY.md), which also records the
deliberate decisions behind the points below.

## Signing status

The direct-download executables are not operating-system code-signed. The APT
repository is separately OpenPGP-signed: APT verifies fingerprint
`30C663842E3433E94B793B79AD4514FE0C3F6F0C`, then verifies the signed index and
the `.deb` hash before installation. That archive signature authenticates the
repository; it does not make Windows display a verified publisher or add an
embedded code signature to the Linux executable.

- **Direct Windows downloads** are unsigned. Microsoft Defender SmartScreen
  can show **Windows protected your PC** because every new unsigned file starts
  without publisher reputation. Windows may offer **More info → Run anyway**,
  but device policy can prevent continuation. Verify that the file came from
  this repository's exact release and matches its published SHA-256 before
  deciding whether to run it. A conventional certificate would display a
  verified publisher and let reputation carry across releases, but Microsoft
  says even a newly signed binary can still be warned about while reputation
  accumulates. A future Microsoft Store package would instead be signed and
  updated by the Store at no charge; it does not exist yet. See Microsoft's
  current [SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).
- **macOS is not built or supported.** Apple documents a manual security
  override for an app from an unidentified developer, so an unsigned download
  is not categorically impossible to open. It is not the normal distribution
  experience Mirafold intends to ask users to accept. A supported direct Mac
  release would first need Developer ID signing, notarization, packaging, and
  real-Mac testing; see Apple's [Developer ID](https://developer.apple.com/support/developer-id/)
  and [Gatekeeper override](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)
  documentation.

## License

MIT — see [LICENSE](LICENSE).
