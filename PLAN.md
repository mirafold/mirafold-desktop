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

**Phase 2 — release: repo + CI DONE, tag HELD (2026-08-02).**

`mirafold/mirafold-desktop` is public. The release workflow was rehearsed with
`workflow_dispatch` and came back **green on both platforms** (run
`30772105738`: Windows 5m26s, Linux 10m32s — free, since Actions is unmetered
on public repos).

The Windows installer was verified as far as it can be without Windows
hardware: it is a real NSIS `PE32` self-extracting installer, and unpacking its
nested payload confirms the **win32** native binaries are present —
`conpty.node`, `conpty.dll`, `OpenConsole.exe`, the win32 `watcher.node`, and
both Windows agent SDK binaries. That rules out the cross-build failure the
Windows-runner requirement exists to prevent. It does **not** prove the app
launches on Windows; only a human on Windows can.

**The `v0.1.0` tag is deliberately not cut.** Kyle's call (2026-08-02): the
build gets tested before anything about it is said publicly, and nothing goes
on the marketing site. Note when planning distribution: **GitHub requires a
login to download workflow-run artifacts even from a public repo**, so testers
cannot be handed a run URL — either the file is relayed by hand, or a tag is
cut so release assets become anonymously downloadable.

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

## Next

1. **Ship the first release.** Create `mirafold/mirafold-desktop`, push, tag
   `v0.1.0`, confirm CI produces Linux and Windows artifacts and that they
   download and run.
2. **Get the Windows build tested by a human.** Nobody on this project has
   Windows hardware. Until a real person installs it, the Windows artifact is
   "CI produced a file", and release notes should not imply more.
3. **A download page.** Nobody can install this if they can't find it. Lives in
   the marketing site, not here.

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
