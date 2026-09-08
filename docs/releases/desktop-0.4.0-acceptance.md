# Desktop 0.4.0 installed acceptance — in progress

Updated 2026-09-07. DPC.11 / Step 13.11 remains unfinished. The next manual
check is persistence across a computer restart. No tag or public release has
been created for this candidate, and no trial or new subscription is authorized.

## Candidate and selected installation

The [frozen candidate](desktop-0.4.0-candidate.md) remains Desktop 0.4.0 with
Shell 0.9.0 from main commit `dd019377cc3975171dd783c6bb71d9ffa20ab6cd`, Release
run `34170884999`, artifact `10035864998`. Its original manifest SHA-256 remains
`32a536b52c108fb19e69b72d7a2c15c3fef2449fe27b01d05b899f62ad2151fb`.
The exact files remain under
`/home/serrecchia/Projects/mirafold-desktop-0.4.0-candidate/files/`.

Kyle chose his existing Ubuntu 24.04.4 amd64 computer and preferred a direct
upgrade over the proposed uninstall/fresh-install procedure. Public APT first
upgraded Desktop 0.3.15 to 0.3.16. He then ran `sudo apt install` in his own
terminal against the frozen local `mirafold-desktop_0.4.0_amd64.deb`.
This is evidence for an upgrade with the existing profile preserved, not a
clean installation or fresh operating system. Do not reintroduce the canceled
uninstall instruction as the next step.

## Completed checks

- All 17 frozen files, the original manifest, and complete release metadata
  still verify. An isolated APT client authenticated the signed candidate
  index, selected version 0.4.0, and downloaded the exact Debian package.
  SHA-256: `4001582a273bb9ae7971d0396ef9fcc92112bece14b579493ee11274482415b8`.
  This index/download check used a local file repository and separate client
  state; the subsequent host installation used the verified local package.
- Seven production page/script responses match reviewed site commit
  `2eb900131133ba8d63733493c420ed03ec75fdf8`. Private API refusals and a
  well-shaped nonexistent-code D1 read returned their expected results.
  These probes created no grant, subscription, customer record or deployment.
- `dpkg-query` reports `mirafold-desktop 0.4.0 install ok installed`.
  Installed package metadata reports Shell 0.9.0. All 3,003 payload files
  match the checksum manifest extracted from the frozen Debian archive;
  no dotenv files were encountered, and all four forbidden filename patterns
  were excluded before content reads. The APT ownership marker is present.
- Kyle opened Mirafold from Ubuntu's application launcher and reported the
  normal window. The assistant's process-name probes did not expose a GUI
  executable, so runtime launch observations are attributed to Kyle rather
  than presented as an automated process inspection.
- The Pair panel initially had no QR code. Kyle located his own existing
  Mirafold license key, entered it in his browser's activation form, and
  reported that it worked. The assistant never received or read the key.
- Kyle confirmed that a QR code appeared, he connected through it, and he
  was using Mirafold on his phone.
- Kyle closed the app using the desktop's right-click Close action and
  reopened it. The installed main-process source quits when its last window
  closes. He reported access without reopening the browser or entering his
  key again, establishing the human application-restart persistence check.

## Remaining checks and boundaries

- Computer restart, followed by Pro access and phone use without reentering
  the license key. Record a before/after boot observation where available.
- Subscription-management access, device-level Pro removal, and
  reconnect/support fallback. Do not cancel Kyle's existing subscription
  merely to exercise a management control.
- A fresh live monthly Paddle trial only after Kyle explicitly authorizes
  creating it: $0 immediately, then $12/month after seven days unless canceled.
  Cancel that test trial in the same acceptance pass. No authorization for it
  has been given, and no test purchase has occurred.
- Complete the remaining installed-flow observations and ordinary npm/browser
  checkout checks. Reconfirm candidate hashes, then mark DPC.11 complete only
  when its selected installed acceptance arc has passed.

Keep main at the candidate commit, next closed to merges until release sync,
and automated releases disabled. DPC.12 publication and public website
positioning remain gated. Windows Pro is a separate deferred proof.

## Permanent continuation

`/home/serrecchia/Projects/mirafold-desktop-dpc11-evidence/HANDOFF.md` is the
current continuation. The same directory holds `acceptance-state.json`,
`production-preflight.json`, `apt-download-preflight.json`,
`installed-package-verification.json`, the scripts and APT logs. Human
observations record outcomes only; no license value, callback/pairing URL,
or phone-session content was captured.

The coordination roadmap is
`/home/serrecchia/Projects/mirafold/ROADMAP.md`. This report and Desktop PLAN.md
live on `docs/desktop-candidate-freeze` in intentionally unmerged draft PR #67,
outside the fixed source checkout. Permanent handoffs in the coordination,
fixed-source, and candidate directories all point to the current checkpoint.
