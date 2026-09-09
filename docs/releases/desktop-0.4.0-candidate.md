# Desktop 0.4.0 frozen candidate

DPC.10 / Desktop Step 13.10 completed on 2026-09-07. One nonpublishing build
produced the retained candidate. DPC.11 installed production acceptance remains
unfinished; these results do not establish that acceptance or Windows Pro support.

## Exact identity

| Input or output | Recorded value |
| --- | --- |
| Desktop / bundled Shell | `0.4.0` / `0.9.0` |
| Fixed `main` commit | `dd019377cc3975171dd783c6bb71d9ffa20ab6cd` |
| Git tree | `8c2e1e761b953aca2294461790582b1f5cddd05e` |
| Reviewed `next` commit with the identical tree | `626eac2968c39a93b89ae669409336e9531f871b` |
| Release source move | [PR #66](https://github.com/mirafold/mirafold-desktop/pull/66), merged 2026-09-07 23:41:05 UTC |
| Candidate workflow | [Release run 34170884999](https://github.com/mirafold/mirafold-desktop/actions/runs/34170884999), `workflow_dispatch`, `main`, attempt 1 |
| Retained Actions artifact | `release-candidate`, ID `10035864998`, 762,058,857 bytes |
| Artifact expiry | 2026-12-06 23:41:38 UTC |
| Archive SHA-256 | `013a311bab67bfc3234fd05c1dfc273139e0b74c6f6a846efe096065be634240` |
| Original `candidate.json` SHA-256 | `32a536b52c108fb19e69b72d7a2c15c3fef2449fe27b01d05b899f62ad2151fb` |

[The original candidate manifest](desktop-0.4.0-candidate.json) is copied
byte-for-byte, including its formatting. It records all 17 release filenames,
sizes, and SHA-256 hashes. Neither it nor the release files were rewritten.
The downloaded ZIP is also retained. Read-only file modes discourage accidental
edits; verification of the recorded hashes establishes byte identity.

## Gates and observations

- [Release PR CI 34170228385](https://github.com/mirafold/mirafold-desktop/actions/runs/34170228385)
  and [exact-main CI 34170857962](https://github.com/mirafold/mirafold-desktop/actions/runs/34170857962)
  passed Linux and Windows. PR #66's automated review completed at 23:39:50 UTC
  without findings before the merge; DCO passed.
- The candidate run passed both native builds, their packaged runtime probes,
  the actual Windows NSIS per-user installation/uninstallation lifecycle,
  isolated APT signing, provenance, and final artifact retention. Candidate
  selection and release publication jobs were skipped. There was one dispatch
  and no job rerun. Native CI also builds its own validation packages; only the
  files from the recorded Release artifact are the frozen candidate.
- The candidate's Linux `npm test` result was 341 passed, one platform skip,
  zero failures; Windows was 274 passed, 68 platform skips, zero failures.
  Both dependency gates reported zero vulnerabilities, 373 verified registry
  signatures and 53 verified package attestations. The unchanged reviewed tree
  also passed `npm run release:rehearse` with all ten scenarios.
- The downloaded ZIP matched the Actions artifact digest. Strict extraction
  accepted exactly the 17 named files plus `candidate.json`, rejecting extra,
  duplicate, unsafe-path, and symlink entries. The candidate validator checked
  the original manifest digest, source/run identity, sizes, and every file hash.
  The complete release-contract validator checked both updater manifests,
  blockmaps, checksums, and the required release asset set.
- APT verification authenticated the repository with the existing approved
  public key fingerprint `30C663842E3433E94B793B79AD4514FE0C3F6F0C`, checked the
  indexes and package hashes, and matched the shipped public key. Debian control
  metadata identifies `mirafold-desktop`, version `0.4.0`, architecture `amd64`,
  with its declared system-library dependencies. Inspected release metadata
  contains release identity and public package/index data. Dotenv contents were
  excluded from all content operations.
- Each downloaded AppImage, tar, and Debian package was independently extracted
  outside the checkout. All 17 runtime source files matched the fixed source.
  The production `verifyPackagedPaths` probe loaded `node-pty` and
  `@parcel/watcher`, initialized the render-MCP server and its `render_card`
  tool, exercised authenticated daemon startup and hardened cookies, and
  confirmed renderer/daemon termination and an unreachable stopped server.
  The source checkout had no development `node_modules` to supply a missing
  packaged runtime dependency. The original files passed hash and complete
  release-contract verification again after the smokes.

## Provenance verification

[Attestation 45839952](https://github.com/mirafold/mirafold-desktop/attestations/45839952)
contains one signed SLSA v1 statement covering all 17 files. GitHub CLI verified
the complete statement using the archive public-key file as the selected
subject; all 17 hashes in that authenticated statement were then compared with
the independently hashed local candidate files. This verifies the full subject
set without claiming a separate CLI invocation for each file.

The verified certificate and statement were checked for issuer
`https://token.actions.githubusercontent.com`, signer
`https://github.com/mirafold/mirafold-desktop/.github/workflows/release.yml@refs/heads/main`,
the fixed source and signer commit above, source ref `refs/heads/main`,
repository ID `1320945606`, owner ID `304260636`, GitHub-hosted runner, and
`workflow_dispatch`. The signed invocation is exactly
`https://github.com/mirafold/mirafold-desktop/actions/runs/34170884999/attempts/1`.
Verified signing timestamps are present.

The installed GitHub CLI 2.45.0 has no attestation command. Verification used
the official standalone GitHub CLI 2.100.0 Linux archive, whose published
SHA-256 was checked before execution:
`e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be`.
This security-protocol verifier costs a 15,152,253-byte download and a
42,188,962-byte executable retained with the evidence. It adds no application
dependency or system installation. Verifier initialization failed in the
sandbox; the identical verification succeeded with approved access outside
the sandbox. No candidate or source change was involved.

## Permanent files and continuation

- Fixed source: `/home/serrecchia/Projects/mirafold-desktop-dpc10-freeze`,
  detached at the recorded main commit, with local `HANDOFF.md`.
- Download and exact files:
  `/home/serrecchia/Projects/mirafold-desktop-0.4.0-candidate/release-candidate.zip`
  and `/home/serrecchia/Projects/mirafold-desktop-0.4.0-candidate/files/`.
- Detailed evidence:
  `/home/serrecchia/Projects/mirafold-desktop-dpc10-freeze-evidence/` contains
  `freeze-state.json`, run/job/artifact records, native logs,
  `archive-verification.json`, `verified-candidate.json`,
  `post-smoke-verification.log`, `apt-verification.log`,
  `provenance-verification.json`, the original signed bundle and CLI result,
  `package-smokes.log`, and `release-rehearsal.log`.
- Completion documentation: `/home/serrecchia/Projects/mirafold-desktop-dpc10`,
  branch `docs/desktop-candidate-freeze`. It must remain unmerged until the
  release cycle's `main` to `next` synchronization permits new merges.

Keep `main` at the recorded commit, hold merges into `next`, and leave
`MIRAFOLD_AUTOMATED_RELEASES=disabled`. No `v0.4.0` tag or public release exists;
the latest public release remains `v0.3.16` at freeze completion. No installed
production acceptance, real Pro key, purchase, or signing-policy change was
performed. Any candidate byte change invalidates this freeze and requires the
owning review and fresh acceptance; an expired Actions artifact cannot be
promoted using this workflow even when a local copy survives.

Next is DPC.11 / Step 13.11, using these exact bytes after the reviewed site
activation endpoints and D1 migration are live. It starts with a clean Linux
APT installation and an existing Pro key entered by Kyle in his own browser.
Any later trial needs separate explicit authorization for $0 today and
$12/month after seven days, with cancellation during that acceptance pass.
Publication belongs to DPC.12, after installed acceptance.
