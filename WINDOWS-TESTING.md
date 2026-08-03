# Testing Mirafold Desktop on Windows

Nobody on this project has a Windows machine, so this build has never been
launched by a human — only produced and inspected by CI. If you're reading
this, you're the first real test. Thank you. The whole thing takes about
ten minutes.

**Two warnings are expected and normal.** The app isn't code-signed yet
(certificates cost a few hundred dollars a year), so both your browser and
Windows will warn you about it. The steps below say exactly where.

## What you need

- Windows 10 or 11, 64-bit.
- About 1 GB of free disk space (the app bundles two complete coding-agent
  runtimes — that's the size, not bloat).
- A way for the AI to answer, one of:
  - **Easiest:** you already use Claude Code, Codex, or Gemini CLI on this PC.
    Your existing login is picked up automatically.
  - Otherwise: an Anthropic or Gemini API key. Step 4 below shows where it goes.

## 1. Download

<https://github.com/mirafold/mirafold-desktop/releases/download/v0.1.1/Mirafold-Setup-0.1.1.exe>

(~230 MB, no GitHub account needed.)

Edge or Chrome may flag the download as "not commonly downloaded." Keep it:
in the downloads popup, click the **⋯** (or the warning itself) → **Keep** →
**Show more** → **Keep anyway**.

## 2. Install

Double-click `Mirafold-Setup-0.1.1.exe`.

- A blue **"Windows protected your PC"** screen appears (SmartScreen). Click
  **More info**, then **Run anyway**.
- A normal install wizard follows: it shows a destination folder and a Next
  button. Accept the defaults.
- ❗ **You should NOT see an admin/UAC elevation prompt** (the dark screen
  asking "Do you want to allow this app to make changes?"). It installs into
  your own user profile on purpose. If you DO get one, that's a bug — please
  note it.

## 3. First launch

Start Mirafold from the Start menu.

1. It asks you to **choose a project folder**. Make a new empty one for the
   test — e.g. `C:\Users\<you>\mirafold-test` — and open it.
2. A dark window appears, then the Mirafold interface loads in it. If instead
   you get an error dialog saying the daemon failed to start, stop here and
   send a screenshot of it — the dialog's details text is exactly what we need.

## 4. If you needed an API key

Skip this if you already use Claude Code / Codex / Gemini CLI on this PC.

Otherwise, in the folder you picked, create a plain-text file named exactly
`.env` (Notepad: File → Save As → filename `".env"` **with the quotes**, type
"All files") containing one line:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

(or `GEMINI_API_KEY=...`), then in Mirafold use menu **File → Open Folder…**
and re-open the same folder.

## 5. The actual checks

Do these in order and note pass/fail for each.

1. **A prompt gets a response.** Type something like *"create a file called
   hello.txt containing hello"* and send it. You should see the agent respond
   and the file appear.
2. **A `!` command works.** Type `!dir` and send it. You should get a real
   directory listing back. (Under the hood this opens a genuine Windows
   pseudo-console — the most Windows-specific thing in the whole app.)
3. **The file tree notices outside changes.** With Mirafold still open, use
   Notepad to save a new file into the project folder. It should show up in
   Mirafold's file tree on its own, without you clicking anything.

## 6. The shutdown check (the one we care most about)

1. Open Task Manager (**Ctrl+Shift+Esc**), go to the **Details** tab, and sort
   by name. While Mirafold is running you'll see several `Mirafold.exe` rows —
   that's normal (the app, its window, and the background daemon are separate
   processes).
2. **Quit Mirafold** (close the window).
3. Refresh your view of Task Manager. There should be **zero** `Mirafold.exe`
   rows left, and no new `node.exe`-ish processes that appeared with the app.
   Leftover processes after quit is exactly the bug this test exists to catch.

## 7. Afterwards

Uninstall whenever you like: **Settings → Apps → Installed apps → Mirafold →
Uninstall**. It's per-user, so no admin prompt there either.

## What to send back

A short list is perfect:

- Windows version (10 or 11)
- Steps 2–6: which passed, which didn't
- Screenshots of anything unexpected — especially any error dialog's full text
- Anything that felt broken, slow, or confusing, even if it "worked"
