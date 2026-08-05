# Mirafold Desktop — plan

Started 2026-08-02. The goal is a download other people can install and run,
on platforms where an unsigned build actually works.

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
2. **Then, and only then, announce.** Requires Kyle's explicit go. A download
   page on mirafold.com lives in the site repo, not here.
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
- **Auto-update — and the coupling it hides.** Nothing here updates itself, and
  there is no notification: someone on `v0.1.0` cannot learn `v0.1.1` exists.
  **The part that is easy to get wrong:** CI builds with `npm ci`, so the
  `mirafold` version in `package-lock.json` is copied into the installer and
  the app resolves the daemon from its *own* bundled copy. It never contacts npm
  at install or run time. So **a user's `mirafold` version is frozen at the day
  their installer was built**, and there is exactly ONE update vehicle — a new
  tag, a new installer, a manual re-download — carrying both upstream and
  desktop changes. This repo's *code* is decoupled from upstream (the whole
  contract is: the daemon entry path, the URL it prints on stdout, and cwd), but
  its *release cadence* is not: every upstream release users should have needs a
  desktop tag. Picking one up isn't automatic for us either — `^0.3.0` is
  overridden by the lockfile, so it takes `npm install mirafold@latest` plus a
  committed lockfile. If this is ever built: electron-builder already emits the
  `latest-*.yml` metadata `electron-updater` consumes, but coverage is uneven
  (Windows NSIS and AppImage can self-update; a `.deb` cannot — the system
  package manager owns it — and `.deb` is the primary Linux artifact), and
  unsigned builds mean update integrity rests on HTTPS plus the metadata
  checksum rather than a signature. Not verified in code — analysis only.
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
