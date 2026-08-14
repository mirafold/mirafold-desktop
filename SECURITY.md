# Security

Thank you for looking. This is a small project, maintained by one person, that
ships installable binaries — so a report that reaches me privately is genuinely
valuable.

## Reporting a vulnerability

**Email <security@mirafold.com>.** Please don't open a public issue for
anything exploitable; that publishes it to everyone who has the app before
there's a fix.

Useful things to include, as far as you have them: what an attacker can do,
the steps to reproduce it, the app version and platform, and whether you
installed from a release asset or ran from a checkout.

What to expect: an acknowledgement within a few days, and an honest answer
about whether I can fix it quickly or not. This is not a funded project and
there is **no bug bounty** — I can offer credit in the release notes, and a
real answer, and that's the whole list. If a report is more than I can handle
alone, I'll say so rather than sit on it.

## What belongs here versus upstream

This repository is a **thin desktop shell**: an Electron window, a folder
picker, a menu, and the code that starts and stops a child process. It
contains no user interface, no server, no agent integration, and no protocol.

- Bugs in the **window, the process lifecycle, packaging, or the installers**
  are this repo's — report them here.
- Bugs in the **Mirafold application itself** — the web interface, the HTTP or
  WebSocket server, agent handling, the auth token, file access — live in the
  [`mirafold`](https://github.com/mirafold/mirafold) package that this app
  consumes as an ordinary dependency. Same email; it helps if you say which.

If you aren't sure, just report it and I'll route it.

## Deliberate decisions, so you don't waste time

These are known and intentional. A report that one of them exists isn't a
finding, but an argument that one of them is *worse than I think* is welcome.

- **The direct-download builds are not operating-system signed.** Windows
  SmartScreen can report an unrecognized app or publisher; whether Windows
  offers a per-file continuation depends on the device's security policy. A
  conventional signature would establish the publisher and allow reputation
  to accumulate across releases, but it would not guarantee that a newly
  signed file avoids SmartScreen. Check the exact GitHub Release and published
  SHA-256 before choosing whether to run an unsigned file. Release checksums,
  updater SHA-512 metadata, and GitHub/Sigstore provenance establish byte and
  build identity, but none makes Windows display a verified publisher. A
  Microsoft Store package would receive free Store signing and Store-managed
  updates, but that package has not been built or certified. macOS is not built
  or supported; a normal direct Mac release would require Developer ID signing,
  notarization, packaging, and real-Mac testing. `npm i -g mirafold` is the same
  Shell software through a channel you may trust more.
- **The window has no bridge into it.** There is no preload script, no IPC
  channel, and no Node access in the page — the window loads the daemon's
  local page the way a browser would. This is deliberate, so that the app
  inherits the web application's own security model instead of creating a
  second one.
- **The daemon runs as a separate process.** The packaged Electron binary
  enters Node mode only for a bootstrap, which removes that environment switch
  before Shell or an agent can inherit it. On Windows the bootstrap is hosted
  by a kill-on-close Job Object and ordinary teardown also uses
  `taskkill /T /F`. On Linux, pseudo-terminal identities are registered at
  creation, corroborated by PID plus kernel start time, and combined with the
  daemon process group. Ordinary quit waits for bounded graceful and forced
  cleanup before Electron exits.
- **The app is large (~300 MB)** because the agent SDKs bundle their own
  runtimes. That's the size of what it runs, not an unexamined dependency.

## Scope

The app runs local coding agents on your own machine, at your direction, with
your credentials — so "the agent modified my files" or "the agent ran a
command" is the product working. What I want to hear about is anything that
lets **someone other than you** reach that capability: a way for a web page,
a repository you merely opened, or another user on the machine to reach the
daemon, the window, or your credentials.
