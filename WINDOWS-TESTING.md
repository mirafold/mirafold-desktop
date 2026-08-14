# Windows human-validation protocol

This is a maintainer test protocol, not a public installation guide. A hosted
Windows runner now proves that the NSIS package installs for one user, starts
its real daemon, loads both native modules, completes the authenticated
loopback handshake, stops its process tree, and uninstalls cleanly. A hosted
runner cannot observe the browser download experience, Windows SmartScreen,
the visible installer, the project-folder picker, a real coding agent, the
interactive pseudo-console, the file watcher, or a human-driven update and
restart. Those claims stay unverified until the evidence record below is
complete.

## Candidate status — paused; the recorded executable is superseded

There is currently **no candidate authorized for human testing**. The retained
candidate recorded below was built before the daemon Job Object, environment
scrubbing, serialized folder switching, and semantic blockmap verification
were added. Its exact historical values remain here so evidence is not erased,
but do not download, install, or give that executable to a tester.

Before Session A begins, a fresh non-publishing Windows run from the current
implementation must pass the normal installed lifecycle plus the new forced
daemon-crash descendant probe. This document must then replace the historical
source commit, run, artifact, retention deadline, byte size, SHA-256, and
embedded versions with that one coherent result. Until that replacement is
written, every Session A instruction below is reference material only.

Do not disable Microsoft Defender, SmartScreen, Smart App Control, or any other
security control for this test. Mirafold's direct installer is currently
unsigned. If Windows offers a per-file continuation after the tester has
verified the checksum, the tester may choose it. If Windows blocks the file or
the tester is not comfortable continuing, stop and record exactly what Windows
showed. That is useful evidence, not a failed favor.

## Why this requires two sessions

The public `v0.1.1` package was built before the updater existed and its release
has no updater metadata. It cannot discover a later Desktop release. A fresh
private candidate will contain the current updater, but there is still
no higher public version for it to install. One session therefore cannot
honestly establish every Windows claim. The historical candidate recorded
below is superseded and is not that fresh candidate.

1. **Candidate session:** exercise the current private package's visible
   installer and ordinary runtime before any release decision. This can find a
   Windows-only product failure without publishing anything.
2. **Production-update session:** only after Kyle explicitly approves and
   publishes the first higher, updater-capable bridge release, install that
   bridge from its public GitHub Release and let it update itself to a still
   higher public release. This establishes anonymous direct download,
   production-feed discovery, verified download, restart, and version change.

The candidate session is worthwhile on its own, but it does **not** complete
the direct-download or automatic-update claim. Do not announce Windows support
as human-verified between the two sessions.

## Tester requirements

Use an ordinary Windows account on Windows 10 or Windows 11, x64, with at least
1 GB free. Prefer a person who has never installed Mirafold Desktop, so an old
same-named installation cannot affect the result. A normal virtual machine is
useful for runtime behavior; record that it is virtual because its reputation
and SmartScreen history may differ from a person's everyday computer.

The test drives a real coding agent. The preferred path is a tester who already
uses **Codex locally on this same Windows account** and can get a response from
`codex` in a normal terminal before installing Mirafold. A local Codex/ChatGPT
subscription login is supported. Claude Code and Gemini subscription logins
alone are deliberately not accepted by Mirafold's third-party application
policy; use those providers only if the tester already supplies an API key
through their normal user environment. Never send a credential to Kyle, paste
one into this report, or create a credential file inside the test project.

Two short live-agent turns are expected. They may count against the tester's
subscription limit or incur the tester's ordinary API usage charge. The test
uses an empty disposable folder so the agent cannot touch a real project.

Ask the tester to avoid screenshots containing credentials, private filenames,
their Windows username, or unrelated applications. Exact warning and error
text can be transcribed when a screenshot would expose private information.

## Superseded historical candidate record — do not use

This record identifies the private package for the first session. It is not the
published `v0.1.1` installer even though both files have the same name.

| Field | Exact value |
| --- | --- |
| Source commit used for the executable | `cb4747912254113fe95f5f762c32af9cdef16401` |
| Non-publishing workflow run | <https://github.com/mirafold/mirafold-desktop/actions/runs/31770520381> |
| GitHub Actions artifact | `windows`, artifact `9208092652` |
| Artifact retention deadline | `2026-08-21 04:47:16 UTC` |
| GitHub artifact-archive digest | `sha256:227793df5732de460fef831a99ff021274fd29f5246f919a483c961333f066e1` |
| Installer | `Mirafold-Setup-0.1.1.exe`, exactly `250098162` bytes |
| Installer SHA-256 | `d16eba272b0fd186e5eccb967b0b71bca1ca6dbe64dda3f06451f7f868835939` |
| Embedded versions | Mirafold Desktop `0.1.1`; Mirafold Shell `0.3.7` |

The adjacent `SHA256SUMS-windows.txt`, updater metadata, block map, and payload
were independently rechecked with the repository's then-current
release-contract verifier. The same workflow's automated
install/run/uninstall proof passed. It did not run the current semantic block
checksum gate or Job Object crash probe. The later commit `6ce2b58` records the
historical proof but changes only documentation.

GitHub may require a signed-in account to retrieve a retained Actions artifact.
That is another reason this download cannot stand in for the later anonymous
GitHub Release test. Even before this artifact expires, it is superseded. Run a
new non-publishing rehearsal and replace this entire record; do not substitute
either this artifact or the older public `v0.1.1` file.

## Session A: current candidate

**Paused:** do not perform this session until the candidate-status section has
been replaced with a fresh exact record from the current implementation.

### 1. Establish the clean test boundary

Record the Windows edition, version, OS build, x64 architecture, whether the
machine is physical or virtual, browser name/version, and whether Mirafold is
already installed. If it is already installed, stop rather than uninstalling
or overwriting someone else's setup for this test.

Confirm the selected live agent answers in its ordinary terminal first. Create
one new empty disposable folder using File Explorer. Do not point Mirafold at a
real project, home directory, cloud-sync root, or folder containing secrets.

### 2. Acquire and verify the candidate

Download the `windows` artifact from the workflow run named above, or receive
the exact extracted installer from the maintainer. A browser download from
Actions may produce `windows.zip`; extract it first.

In File Explorer, open the folder containing only the extracted candidate,
click the address bar, type `powershell`, and press Enter. Then run:

```powershell
Get-FileHash -Algorithm SHA256 .\Mirafold-Setup-0.1.1.exe
```

The displayed hash must match the installer SHA-256 in the candidate table,
case-insensitively, and the file's Properties dialog must show exactly
`250098162` bytes. If either differs, do not run it. Record the actual value and
how the file was obtained.

Record any browser or archive warning, but do not count it as the final
direct-download observation: this is an Actions artifact, not a public Release
asset.

### 3. Observe the unsigned visible installer

Double-click the verified installer. Record, without assuming in advance:

- whether Windows shows SmartScreen, Smart App Control, Defender, or another
  reputation warning;
- the exact publisher wording and every choice Windows offers;
- whether a **User Account Control** elevation prompt appears;
- whether a visible Mirafold setup wizard appears;
- whether its destination is shown and the destination selector can be opened;
- the destination actually used; and
- whether installation finishes and Mirafold can be launched from the Start
  menu.

The intended behavior is a visible, per-user installer with an editable
destination and no administrator elevation. Do not turn off a security control
to obtain that result. If the verified file is allowed to continue, use only
the route Windows itself presents for this one file.

### 4. Exercise the project and agent paths

On first launch, the native dialog title should be **Choose a project folder**
and its confirmation button should be **Open**. Select the empty disposable
folder. Record whether the Mirafold window loads or instead shows an error; for
an error, capture its complete detail text without private paths.

In Mirafold's onboarding, select the live provider confirmed before the test.
The provider must be shown as available rather than demo, blocked, or missing.
Do these checks in order:

1. Send: `Reply with exactly WINDOWS AGENT OK. Do not change files or run commands.`
   Record whether the response comes from the selected real provider.
2. Send `!dir`. Record whether a real Windows directory listing appears and
   whether Mirafold remains responsive after the command completes. This is the
   Windows ConPTY path and may cause the agent to send one follow-up response.
3. While Mirafold remains open, use Notepad to create
   `outside-watcher-check.txt` in the disposable folder. Record whether it
   appears in Mirafold's Explorer without reload, folder reopening, or another
   click.
4. Open **Help** and record the displayed Desktop and Shell versions. For this
   candidate they must be Desktop `0.1.1` and Shell `0.3.7`, and **Check for
   Updates…** must exist. Do not use the update command in Session A: the
   current public release deliberately lacks its metadata.

### 5. Prove ordinary shutdown and cleanup

Open Task Manager with **Ctrl+Shift+Esc**, select **Details**, and note every
`Mirafold.exe` row while the app is open. Close Mirafold normally. Do not use
**End task** or `taskkill` unless cleanup has already failed and the evidence
has been captured, because either would hide the behavior under test.

After ten seconds, refresh Task Manager. There must be zero `Mirafold.exe`
rows. If any remain, record their process identifiers and screenshot the rows;
only then end them to make the tester's machine safe.

Finally use **Settings → Apps → Installed apps → Mirafold → Uninstall**.
Record whether uninstall is visible, succeeds without administrator elevation,
removes the chosen installation directory, and removes Mirafold from the Start
menu. Uninstalling the disposable test application and deleting the disposable
test folder are the only cleanup actions authorized by this protocol.

## Session B: public bridge to higher public release

Do not begin this session until the maintainer has filled every field below,
both releases are public, the bridge is known to contain the updater, and Kyle
has explicitly approved the release activity. Public tags or releases are not
created merely to make this test possible.

| Field | Maintainer must fill before the test |
| --- | --- |
| Bridge GitHub Release URL | Pending |
| Bridge Desktop version | Pending |
| Bridge Mirafold Shell version | Pending |
| Bridge installer filename, byte size, and SHA-256 | Pending |
| Higher target GitHub Release URL | Pending |
| Expected target Desktop version | Pending |
| Expected target Mirafold Shell version | Pending |
| Expected target installer SHA-256 | Pending |

Use a clean Windows account or confirm the Session A candidate was completely
uninstalled. Download the bridge installer through an ordinary browser from
the exact public GitHub Release URL. This time, record the browser warning and
Windows reputation flow as the production direct-download observation. Verify
the exact byte size and SHA-256 supplied in the completed table before running
the installer.

Install and launch the bridge through the same visible current-user installer,
Start-menu, folder-picker, and live-agent checks used in Session A. Record UAC
again rather than assuming it is absent. Confirm the Help menu shows the bridge
Desktop and Shell versions.

Leave Mirafold open and connected without choosing **Check for Updates…**. The
startup check should discover and download the higher public target in the
background, then show **Mirafold update ready** with **Install and restart** and
**Later** choices. Record the elapsed time and exact dialog. If the allotted
test window ends first, report “automatic prompt not observed” with the wait
duration and network conditions; do not turn a manual check into an automatic
success claim.

Choose **Later** and confirm Mirafold keeps working. Without closing the app,
choose **Help → Check for Updates…** and confirm the ready-to-install choice
returns immediately from the verified cached download. Choose **Later** again,
close Mirafold normally, and reopen it. Help must still show the bridge Desktop
version: an ordinary close must not install the update. If the startup check
shows the ready prompt again, that is expected; choose **Install and restart**.
Otherwise choose **Help → Check for Updates…**, then **Install and restart**.
Observe all of the following:

- the old app stops before the installer changes files;
- the visible installer starts without administrator elevation;
- the higher version reopens automatically;
- Help now shows the exact target Desktop and bundled Shell versions;
- the live agent and `!dir` still work in the selected disposable folder; and
- after the updated app is closed normally and ten seconds pass, Task Manager
  shows zero `Mirafold.exe` rows.

A lower Desktop version is never used for rollback; recovery is tested only
with a higher version carrying restored source.

## Evidence record

Return the completed record below plus redacted screenshots for unexpected
warnings, errors, leftover processes, and the ready/restart dialogs. “Not
shown” is an observation; do not replace it with what the guide predicted.

```text
WINDOWS HUMAN VALIDATION

Tester/date/time zone:
Windows edition/version/build/x64:
Physical machine or virtual machine:
Browser/version:
Live provider path (no credential):
Previously installed Mirafold: yes/no

SESSION A — PRIVATE CANDIDATE
Exact candidate SHA-256 matched: yes/no
Candidate byte size matched: yes/no
Acquisition method:
Browser/archive warning observed:
Windows reputation warning and publisher text:
Per-file continuation offered: yes/no
UAC elevation appeared: yes/no
Visible installer and editable destination: pass/fail + destination
Start-menu launch: pass/fail
Project-folder picker: pass/fail
Real-agent response: pass/fail
!dir / ConPTY: pass/fail
External file watching: pass/fail
Help versions and update command: pass/fail + values
Zero Mirafold.exe after ordinary quit: pass/fail + observed count
Uninstall, directory removal, Start-menu removal: pass/fail
Unexpected behavior and redacted evidence filenames:

SESSION B — PUBLIC BRIDGE UPDATE
Bridge release URL/version/hash verified:
Anonymous browser download: pass/fail
Browser and Windows reputation observations:
Bridge install/start/folder/agent checks: pass/fail
Bridge Desktop and Shell versions:
Automatic ready prompt without menu action: pass/fail + elapsed time
Later kept the running version: pass/fail
Cached prompt reopened from Help: pass/fail
Visible no-UAC update installer: pass/fail
Automatic restart into target: pass/fail
Target Desktop and Shell versions:
Post-update real-agent and !dir checks: pass/fail
Zero Mirafold.exe after updated-app quit: pass/fail + observed count
Unexpected behavior and redacted evidence filenames:
```

The Windows human-validation gate is complete only when both sessions have
literal observations for every required line. A candidate-only pass remains
valuable evidence, but it is not a production updater pass and not a public
launch claim.
