# Mirafold Desktop

Mirafold in its own window — no terminal, no Node, no npm.

[Mirafold](https://mirafold.com) is a faithful browser re-skin of the terminal
coding agent you already use (Claude Code, Codex, Gemini CLI) with generative UI
layered on top. It normally installs with `npm i -g mirafold` and runs from a
terminal. This repo wraps that same software in a desktop application so that
installing it is a download and a double-click.

**Download:** [Releases](https://github.com/mirafold/mirafold-desktop/releases)
— Linux (`.deb`, `.tar.gz`, `.AppImage`) and Windows (`.exe`).

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
