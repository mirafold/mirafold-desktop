Mirafold as a desktop app — no terminal, no Node, no npm.

Pick a project folder, and Mirafold opens in its own window. Everything the
`mirafold` npm package does, this does: it runs the same daemon, unmodified.

## The one-time update bridge

<!-- Refresh this section before any manually tagged release. Automated Shell
     intake generates separate, version-bound notes from reviewed provenance. -->

The older public `v0.1.1` application has no updater and cannot discover this
release. Existing Desktop users must download and install this release once.
After that bridge, each supported direct package checks the official Desktop
release feed after startup and through **Help → Check for Updates…**. The Help
menu displays the independent Desktop version and the exact Mirafold Shell
version bundled inside it.

Direct Windows, AppImage, and Debian installations download and verify a newer
release in the background, then ask before stopping Mirafold and opening the
platform installer. Choosing **Later** never installs on ordinary quit. An
extracted Linux `.tar.gz` only announces the update and opens the official
Releases page; it never changes the extracted files. Microsoft Store packaging
does not exist yet and will use Store-managed updates when it does.

This release also includes the current process-lifecycle, navigation,
permission, credential-redaction, packaged-runtime, and release-provenance
hardening. A failed check leaves the current session running. Installation does
not begin unless the daemon and its agent process tree are confirmed stopped,
including Linux pseudo-terminal children registered synchronously when they
enter separate process groups. Electron's Node-mode bootstrap flag is removed
before Shell or an agent can inherit it, rapid folder changes cannot overlap,
and Windows daemon descendants live in a kill-on-close Job Object. Ordinary
quit now waits for the same bounded cleanup. Read-only build gates recompute
every differential-update block checksum from its payload bytes. AppImage
replacement stages and launches the verified file before removing the current
executable, and a Windows installer-launch failure no longer closes the
recovered session.

## Which file do I want?

**Linux**

| file | for |
| --- | --- |
| `.deb` | Debian, Ubuntu, Mint, Pop!_OS — double-click, or `sudo apt install ./Mirafold-*.deb` |
| `.tar.gz` | everything else (Fedora, Arch, openSUSE…). Extract and run `./mirafold`. No dependencies. |
| `.AppImage` | portable single file. This target needs FUSE 2 on the host; if it fails with `dlopen(): error loading libfuse.so.2`, install the distribution's FUSE 2 compatibility package or use the `.tar.gz` instead. |

Once an updater-capable release is installed, AppImage and Debian-package
users receive verified in-app downloads and an explicit restart choice. Debian
installation requests administrator authorization through the operating
system's available elevation helper; an AppImage replaces its user-owned file
without it, with atomic staging and rollback protection. The extracted `.tar.gz`
checks for new versions but changes no files: its notice opens the official
Releases page for a manual replacement. The older public `v0.1.1` build cannot
discover its successor, so moving from that build still requires one manual
download. The updater refuses lower Desktop versions; a recovery release uses
a new, higher Desktop version containing the restored known-good source.

**Windows** — `Mirafold-Setup-*.exe`. It is configured as a visible,
current-user installer with an editable destination. The hosted Windows probe
has proved silent installation and registration only for that user, followed
by clean runtime and uninstall. SmartScreen, the visible wizard, elevation,
and a human-driven update remain pending real-Windows observations.

**macOS** — no package is built or supported. Apple allows a user to override
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
Code, Codex, and Gemini CLI do not all accept the same login or credential
types in Mirafold, so an existing subscription login is not a universal
guarantee. The app does not ask you to send credentials to the Desktop
maintainer. If no live path is available, demo mode shows the interface with
scripted replies. **Help** shows the exact Shell version whose provider policy
applies to this release.
