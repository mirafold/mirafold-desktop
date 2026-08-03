Mirafold as a desktop app — no terminal, no Node, no npm.

Pick a project folder, and Mirafold opens in its own window. Everything the
`mirafold` npm package does, this does: it runs the same daemon, unmodified.

## What changed in 0.1.1

<!-- Refresh this section when cutting a release; the rest of the file is
     evergreen install guidance reused by every build. -->

Reliability and hardening. No feature changes.

- Switching project folders (or quitting) while the app was still starting
  could leave the background daemon running after you closed the app, and
  could show a "couldn't start" error over a session that was working fine.
- Coding agents installed through a version manager (nvm, asdf, volta, fnm)
  could go undetected if your shell profile printed anything on startup —
  a greeting, a fetch banner, or Ubuntu's own `sudo` hint.
- A failed startup now shuts down everything it started, rather than leaving
  agent processes behind.
- The app no longer writes its session's access token to the system log, and
  the window can no longer be navigated away from Mirafold to a local file.

## Which file do I want?

**Linux**

| file | for |
| --- | --- |
| `.deb` | Debian, Ubuntu, Mint, Pop!_OS — double-click, or `sudo apt install ./Mirafold-*.deb` |
| `.tar.gz` | everything else (Fedora, Arch, openSUSE…). Extract and run `./mirafold`. No dependencies. |
| `.AppImage` | portable single file — **needs `libfuse2`**, which most current distros no longer install by default. If it fails with `dlopen(): error loading libfuse.so.2`, either install libfuse2 or use the `.tar.gz` instead. |

**Windows** — `Mirafold-Setup-*.exe`. Installs into your user profile, so there's
no administrator prompt.

**macOS** — not yet. An unsigned Mac build isn't merely warned about, it's
blocked outright by Gatekeeper, so shipping one would waste your time. It needs
Apple Developer signing and notarization first.

## About the Windows warning

This build is **not code-signed**, so Windows SmartScreen will say it doesn't
recognize the publisher. To continue: **More info → Run anyway**. A signing
certificate is a recurring annual cost that this project hasn't taken on yet.
If that trade isn't one you want to make, `npm i -g mirafold` is the same
software through a channel you may trust more.

## What you still need

An agent to drive. Mirafold re-skins the coding agent you already use — Claude
Code, Codex, or Gemini CLI — and reads whatever credentials or logins those
already have on your machine. If you don't have one set up, the app opens in a
demo mode that shows the interface with scripted replies.
