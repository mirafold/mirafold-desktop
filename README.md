# Mirafold Desktop

Mirafold in its own window — no terminal, no Node, no npm.

[Mirafold](https://mirafold.com) is a faithful browser re-skin of the terminal
coding agent you already use (Claude Code, Codex, Gemini CLI) with generative UI
layered on top. It normally installs with `npm i -g mirafold` and runs from a
terminal. This repo wraps that same software in a desktop application so that
installing it is a download and a double-click.

**Download:** [Releases](https://github.com/mirafold/mirafold-desktop/releases)
— Linux (`.deb`, `.tar.gz`, `.AppImage`) and Windows (`.exe`).

## How Linux updates work

The public `v0.1.1` build predates the updater, so it cannot discover a newer
release. Install the first updater-capable release manually once. After that,
Mirafold checks for a newer Desktop release after startup and through **Help →
Check for Updates…**. A Desktop release carries its own exact Mirafold Shell
version; the Help menu shows both versions separately.

| installed form | when a newer release exists |
| --- | --- |
| `.AppImage` | Downloads and verifies the new AppImage, asks before restarting, stops the complete daemon/agent process tree, and replaces the current user-writable file without administrator access. |
| `.deb` | Downloads and verifies the new Debian package, asks before restarting, stops the complete daemon/agent process tree, then requests administrator authorization through the available system elevation helper before running `dpkg -i`. The local probe selected `pkexec`; the exact authorization dialog depends on the Linux desktop. |
| extracted `.tar.gz` | Shows a native notice and opens the official HTTPS Releases page. It never downloads an installer or changes the extracted tree; close Mirafold and replace it manually. |

Choosing **Later** never installs on ordinary quit. Microsoft Store packages,
once offered, use the Store's update channel instead of contacting GitHub.
Mirafold also refuses lower-numbered Desktop versions. If a release must be
recovered, maintainers rebuild the last known-good source as a new, higher
Desktop version so every user moves forward through the same verified path.

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

The child is started with **Electron's own binary** under
`ELECTRON_RUN_AS_NODE=1`, which makes it behave as a plain Node interpreter.
That is what lets this app run on a machine with no Node.js installed.

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
| `src/daemon.js` | spawn the daemon, read its URL, kill its whole process tree |
| `src/navigation.js` | what the window is allowed to load, and what goes to the browser |
| `src/updater.js` | update policy for direct installers, Store packages, and Linux tar archives |
| `src/login-env.js` | recover the login shell's `PATH` so agent CLIs are findable |
| `src/state.js` | remember the last-opened folder |
| `electron-builder.yml` | packaging targets, with the reasoning as comments |

## Development

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

Node's built-in runner, no test dependencies. They pin the process-teardown,
`PATH`-recovery and navigation rules — the seams where this app's real risk
lives — and CI runs them on Linux and Windows before packaging anything. Write
them to pass on both: a Windows checkout converts line endings to CRLF, and
`fileURLToPath` returns backslashes there.

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
and `/.github/workflows/release.yml` on a GitHub-hosted runner. Only the reviewed
`package.json`, `package-lock.json`, and compact `shell-intake.json` evidence
cross into fresh read-only test and build jobs. The native Linux and Windows
runners independently apply that exact pair, install with lifecycle scripts
disabled, validate the dependency tree, advisories, registry signatures, and
attestations, run the full suite, and build their native installers. Each
packaged Electron runtime must then resolve the real bundled daemon and load
both native wrappers before its complete updater artifact set is retained.

After every read-only gate succeeds, a separate job reconstructs the same
candidate without installing dependencies. It permits only the reviewed
package/lock change, advances `main` and one annotated Desktop tag through one
atomic Git push, creates a draft release, uploads all nine Linux/Windows
payload, updater, and SHA-256-manifest files, and verifies the remote title,
notes, names, sizes, and GitHub-calculated SHA-256 digests before the release
can become public and `latest`.
Before that writer can run, an isolated short-lived GitHub identity creates
SLSA build provenance for the exact nine digests; dependency and build jobs
never receive its OpenID Connect or attestation permissions. A stale `main`, a
conflicting tag, or a different candidate fails closed. A retry recognizes the
exact prior commit, tag, complete draft, or complete public release and resumes
without creating a second Desktop version. For an interrupted writer, re-run
the failed jobs in the same workflow run so it retains the original commit and
artifacts.

Publication is intentionally dormant: the repository Actions variable
`MIRAFOLD_AUTOMATED_RELEASES` must equal the literal value `enabled` before the
write job can run. Keep it absent through the one-time updater bridge release
and the non-publishing rehearsal. Once that gate is deliberately enabled,
ordinary Shell releases require no Desktop source edit, version command, tag,
installer build, or GitHub Release action from a maintainer.

`npm run release:rehearse` runs the deterministic, local, non-networked release
state-machine rehearsal. It covers no update, one update, rapid consecutive
updates, either native build failing, stale `main`, a duplicate run, every safe
retry state, publication isolation, and the exact Shell identity carried from
reviewed intake into the proposed native package. A manual dispatch of the
`Release` workflow is the separate native Linux/Windows rehearsal: it builds,
smoke-checks, verifies, retains, and attests the nine files, while the event gate
keeps its only `contents: write` publication job skipped.

Every workflow action is pinned to a reviewed commit SHA. Normal pushes and
pull requests run stable `test (linux)` and `test (windows)` checks, while
weekly Dependabot pull requests review npm dependencies and those action pins.
The exact proposed repository rules, release environments, free security
settings, account responsibilities, and break-glass recovery procedure are in
[RELEASE-RECOVERY.md](RELEASE-RECOVERY.md). Those external GitHub settings are
prepared but intentionally not applied until the non-publishing rehearsal
proves the live workflow behavior.

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

Nothing here is code-signed yet.

- **Windows** ships unsigned: SmartScreen warns, users click through with
  "More info → Run anyway". An OV certificate ($200–400/yr) would remove it.
- **macOS is not built at all.** Unsigned Mac apps aren't warned about, they're
  refused by Gatekeeper — so an unsigned `.dmg` would be useless to whoever
  downloaded it. It needs Apple Developer Program membership ($99/yr) plus
  notarization first.

## License

MIT — see [LICENSE](LICENSE).
