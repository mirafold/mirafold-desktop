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

**Phase 2 — release: DONE (2026-08-02). `v0.1.0` is published.**

Four installers on GitHub Releases: `mirafold-desktop_0.1.0_amd64.deb` (236 MB),
`mirafold-desktop-0.1.0.tar.gz` (295 MB), `Mirafold-0.1.0.AppImage` (312 MB),
`Mirafold-Setup-0.1.0.exe` (230 MB). Release run `30772737027`, all three jobs
green. **Anonymous download verified** — an unauthenticated range request
returned `206` with a valid `PE32` header, so a tester needs no GitHub account.
That was the whole reason to cut the tag: GitHub requires a login to download
*workflow-run* artifacts even from a public repo, so without a release there was
no way to hand anyone the file.

**Not announced anywhere, and nothing goes on mirafold.com** (Kyle,
2026-08-02) until it has been tested. The repo is public and therefore
indexable, but nothing links to it.

**Post-release fixes on main, 2026-08-03 — NOT in the v0.1.0 installers.** A
full-project bughunt found and fixed three bugs: a chatty login-shell profile
corrupted the first PATH entry in `login-env.js` (reproduced; even Ubuntu's
stock bashrc triggers it); boots weren't serialized, so File → Open Folder or
a quit during a slow boot could orphan a daemon past quit and raise a spurious
error dialog; and a daemon dying right after reporting its URL stacked two
error dialogs. All pinned by the repo's new test suite (`npm test`, node
--test, zero added dependencies, wired into CI). **Decide before the Windows
test: cut v0.1.1 so the tester gets these fixes, or hand out v0.1.0 knowing
its orphan check can false-fail via the folder-switch race.**

**Security audit, 2026-08-03 — all five findings fixed, also not in v0.1.0.**
Clean on the things that matter most: no secrets anywhere in git history, zero
dependency vulnerabilities, all 399 lockfile entries hashed and registry-sourced,
Electron 43.2.0 (latest, Chromium 150), and the packaged payload carries only
production dependencies — no dev tooling, tests, or planning docs. Fixed: the CI
build job inherited a repo-**write** token while running ~400 packages' install
scripts (now read-only, `persist-credentials: false`; the release job alone
writes); the `will-navigate` guard permitted every `file://` URL (Chromium
blocked it independently — verified in a real window — so nothing was
exploitable, but the rule is ours now, in `src/navigation.js`); the daemon's
per-launch auth token was mirrored to app stdout and into the crash dialog; and
the crash buffer capped line count but not line length. `SECURITY.md` now gives
a private reporting channel and records the deliberate decisions, so future
audits don't re-litigate unsigned builds, the no-bridge window, or the size.

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
   **Tester instructions exist: `WINDOWS-TESTING.md`** (added 2026-08-03) — a
   self-contained checklist covering all of the above plus the download-warning
   click-throughs and the API-key path; send a tester that one file and nothing
   else is needed. The download URL in it was re-verified anonymous-accessible
   (HTTP 200, no auth) the same day.
2. **Then, and only then, announce.** Requires Kyle's explicit go. A download
   page on mirafold.com lives in the site repo, not here.
3. **Push the held `genui-shell` commit.** `6d31c39` corrects `POST-RELEASE.md`
   there, but that file ships in the **public** `mirafold/mirafold` repo, so
   pushing it announces this app's existence. Held deliberately; push it when
   the announcement happens.

## Known gaps, not yet scheduled

- **Credential entry has no GUI.** The onboarding screen tells you to set
  `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, which assumes a terminal. Users who
  already have Claude Code, Codex, or Gemini CLI logged in are fine — their
  existing config is picked up, and they are the target audience — but a
  brand-new user with only an API key has to hand-write a `.env` in the project
  folder. A settings screen would fix it; it likely belongs upstream.
- **Auto-update.** Nothing here updates itself. Worth doing once there are
  enough users that asking them to re-download is rude.
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
  the right call; nobody has watched it work.
- **A hard kill of the app orphans the daemon.** The daemon is spawned
  `detached` so its process group can be signalled, which by construction means
  it survives a `SIGKILL` of the app. Normal quit and window close are handled.
