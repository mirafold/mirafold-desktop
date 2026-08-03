# PLAN-ARCHIVE.md — mirafold-desktop

Completed material moved verbatim out of PLAN.md to keep the plan lean — the
archive is the permanent record and is never itself condensed.

## Archived by prune, 2026-08-02 — moved verbatim from PLAN.md

### Earlier state, kept for the record

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
