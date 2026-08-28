Mirafold as a desktop app — no terminal, no Node, no npm.

Pick a project folder, and Mirafold opens in its own window. Everything the
`mirafold` npm package does, this does: it runs the same daemon, unmodified.

## What changed in Desktop 0.3.2

Desktop 0.3.2 keeps the bundled Mirafold Shell at `0.5.0` and fixes Desktop's
session, notification, and startup behavior:

- **New sessions stay authenticated.** Shell's exact **New session** control
  now opens in the existing Desktop window instead of an external browser that
  does not possess the daemon's private launch token. Ordinary links still
  open in the system browser, and new-window form submissions are refused
  rather than silently losing their POST body.
- **Operating-system notifications work without broadening permissions.** The
  active daemon's main frame may use Shell's opt-in notifications. Every other
  Chromium permission, another window, a subframe, an external origin, and a
  prior daemon origin remain denied.
- **Startup and updating agree on success.** The Desktop updater starts exactly
  once after a working session loads, including after a successful retry. It
  does not start after a failed boot, a crash during initial page load, or a
  user choosing **Quit**.
- **Failure paths are controlled and credential-safe.** Rejected popup and
  external-navigation actions no longer escape as unhandled promises. Startup
  dialogs redact daemon tokens and relay pairing codes, and a missing local
  loading interface reports one error and quits before launching a daemon.

## Install on Ubuntu with APT

<!-- Refresh this section before any manually tagged release. Automated Shell
     intake generates separate, version-bound notes from reviewed provenance. -->

Mirafold's signed Ubuntu APT repository is already live. Desktop 0.3.2 is an
ordinary package update on that channel, not a new repository setup. Ubuntu
24.04 on `amd64` is the tested target. Existing APT users need no new bootstrap
package: after `sudo apt update`, Ubuntu's Software Updater or
`sudo apt install mirafold-desktop` upgrades the app. New users download the
small repository-identity package once, then install Mirafold by package name:

```
curl --fail --location --output /tmp/mirafold-archive-keyring_1.0_all.deb https://github.com/mirafold/mirafold-desktop/releases/latest/download/mirafold-archive-keyring_1.0_all.deb
sudo apt install /tmp/mirafold-archive-keyring_1.0_all.deb
sudo apt update
sudo apt install mirafold-desktop
```

The repository key fingerprint is
`30C663842E3433E94B793B79AD4514FE0C3F6F0C`. Its bootstrap package restricts
that key to Mirafold's source with APT's `Signed-By` mechanism. APT verifies
the signed index and exact `.deb` hash before installation. The Help menu says
**Updates managed by APT** for this form, while a standalone downloaded `.deb`
retains Mirafold's verified in-app updater.

The older public `v0.1.1` application has no updater and cannot discover a
successor. Existing `v0.1.1` users must install a current release once. Current
direct Windows, AppImage, and standalone Debian installations check the
official Desktop release feed after startup and through **Help → Check for
Updates…**. Choosing **Later** never installs on ordinary quit. An extracted
Linux `.tar.gz` only announces the update and opens the official Releases page;
it never changes the extracted files. Microsoft Store packaging does not exist
yet and will use Store-managed updates when it does.

Desktop 0.3.2 retains the process-lifecycle, navigation, permission,
credential-redaction, packaged-runtime, and release-provenance protections
shipped in earlier releases. A failed check leaves the current session running.
Installation does not begin unless the daemon and its agent process tree are
confirmed stopped, including Linux pseudo-terminal children registered
synchronously when they enter separate process groups. Electron's Node-mode
bootstrap flag is removed before Shell or an agent can inherit it, rapid folder
changes cannot overlap, and Windows daemon descendants live in a kill-on-close
Job Object. Ordinary quit waits for the same bounded cleanup. Read-only build
gates recompute every differential-update block checksum from its payload
bytes. AppImage replacement stages and launches the verified file before
removing the current executable, and a Windows installer-launch failure does
not close the recovered session.

## Which file do I want?

**Linux**

| file | for |
| --- | --- |
| `mirafold-archive-keyring_1.0_all.deb` | Ubuntu 24.04 `amd64` — recommended one-time APT repository setup; then run `sudo apt install mirafold-desktop` |
| `mirafold-desktop_*_amd64.deb` | standalone Debian-family install without adding the repository; double-click it or run `sudo apt install ./mirafold-desktop_*_amd64.deb` |
| `.tar.gz` | everything else (Fedora, Arch, openSUSE…). Extract and run `./mirafold`. No dependencies. |
| `.AppImage` | portable single file. This target needs FUSE 2 on the host; if it fails with `dlopen(): error loading libfuse.so.2`, install the distribution's FUSE 2 compatibility package or use the `.tar.gz` instead. |

APT installations receive later versions through `apt upgrade` or Ubuntu's
software updater. AppImage and standalone Debian-package users receive verified
in-app downloads and an explicit restart choice. A standalone Debian update
requests administrator authorization through the operating system's available
elevation helper; an AppImage replaces its user-owned file without it, with
atomic staging and rollback protection. The extracted `.tar.gz` checks for new
versions but changes no files: its notice opens the official Releases page for
a manual replacement. The updater refuses lower Desktop versions; a recovery
release uses a new, higher Desktop version containing the restored known-good
source.

**Windows (beta)** — `Mirafold-Setup-*.exe`. It is configured as a visible,
current-user installer with an editable destination. The hosted Windows probe
has proved silent installation and registration only for that user, followed
by clean runtime and uninstall. SmartScreen, the visible wizard, elevation,
and a human-driven update remain pending real-Windows observations.

**macOS** — not available: no package is built or supported. Apple allows a user to override
the unidentified-developer block manually, but Mirafold will not call that a
normal supported install path. Direct Mac distribution needs Developer ID
signing, notarization, packaging, and real-Mac testing first.

## About the Windows warning

This direct-download build is **not code-signed**. SmartScreen can show
**Windows protected your PC** because a new unsigned file has no transferable
publisher reputation. Windows may offer **More info → Run anyway**; managed or
hardened devices can block continuation. Verify the exact GitHub Release and
its published SHA-256 before deciding whether to run it. A conventional
certificate would show a verified publisher and let reputation accumulate, but
Microsoft does not promise that a newly signed file immediately avoids a
warning. The planned Microsoft Store package would be signed and updated by
the Store for free, but it has not been implemented. If the unsigned direct
path is not acceptable, `npm i -g mirafold` is the same Shell software through
a channel you may trust more.

## What you still need

An agent path that the bundled Mirafold Shell reports as available. Claude
Code, Codex, OpenCode, and Gemini CLI do not all accept the same login or
credential types in Mirafold, so an existing subscription login is not a
universal guarantee. The app does not ask you to send credentials to the
Desktop maintainer. If no live path is available, demo mode shows the interface
with scripted replies. **Help** shows the exact Shell version whose provider
policy applies to this release.
