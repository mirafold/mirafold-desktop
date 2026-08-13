# Working rules for this repo

Mirafold Desktop is a **thin Electron shell** around the published `mirafold`
npm package. Read `README.md` first for the architecture; this file is the set
of rules that are easy to violate by accident. `GLOSSARY.md` is the Mirafold
product vocabulary (shell, daemon, session, viewport, …); docs and user-facing
copy here use its terms.

## The prime directive: this repo contains no product

There is no UI here, no server, no agent adapter, no protocol. All of that is
the `mirafold` package, consumed as an ordinary dependency. If a change here
starts to look like product behavior, it belongs upstream instead.

**Never vendor, patch, or fork anything out of `mirafold`.** The value of this
build is that it runs the exact artifact npm users install; a local divergence
destroys that and creates a second thing to keep in sync.

## Hard constraints

- **The daemon runs as a child process, never in-process.** Crash isolation,
  event-loop isolation, and per-folder working directories all depend on it.
  The reasoning is in `src/daemon.js`'s header; read it before proposing a
  change.
- **No preload script, no IPC, no `nodeIntegration`.** The window loads the
  daemon's page as an ordinary web page. Mirafold's security model assumes a
  plain browser context, and every bridge added here is a hole punched in it.
  Native capability belongs in the main process, which needs no bridge.
- **Never add `electron-rebuild`.** Both native modules are Node-API addons and
  load unmodified under Electron. A rebuild step would be pure liability.
- **Windows packages must be built on a Windows runner.** npm on Linux will not
  fetch the win32 platform binaries; a cross-built package installs and then
  fails on first use.

## Dependencies

Three, total: `mirafold`, `electron`, `electron-builder`. Every one of them
carries a real justification.

A new dependency must earn its place. Prefer writing a small thing ourselves
when it's a sliver of convenience with no security-sensitive surface —
`src/login-env.js` is the worked example, replacing `fix-path`/`shell-env` with
fifteen lines. Take the dependency for genuine protocol depth, native/platform
code, a vendor SDK, or a security-hardened surface.

## Verification that actually counts

The deliverable is an installer a stranger can download and run. A dev-checkout
`npm start` proving something is a precondition, not a result.

Before calling a packaging change done:

1. Build the artifact.
2. Run it from **outside** the dev checkout, with `node_modules` out of the
   picture.
3. Exercise **both native modules**, since they're what packaging most often
   breaks: run a `!` shell command (that's `node-pty`), and open the file tree
   and edit a file externally to see it update (that's `@parcel/watcher`).
4. Quit, then check for orphans — no daemon, no agent CLI left running.

## The size question, already settled

The app is ~300 MB because the Claude and Codex SDKs each bundle a full agent
binary. That is not waste and not a packaging mistake — it is what lets the app
work without a separately installed CLI. It cannot be trimmed from this repo
without changing upstream. Don't re-derive this.

## Signing

Windows ships unsigned by decision (SmartScreen warns; users click through).
macOS is not built at all, because unsigned Mac builds are refused outright
rather than warned about, which would make the download useless. Neither is an
oversight; both are cost decisions with a stated price.
