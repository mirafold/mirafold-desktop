# Desktop 0.4.0 public release — complete

Completed 2026-09-08 (publication timestamp 2026-09-09T03:55:03Z).
Kyle explicitly authorized acceptance closeout, publication, and website work
after accepting the observed upgrade results and stopping extra manual testing.
The [acceptance record](desktop-0.4.0-acceptance.md) preserves the unperformed
checks as unperformed. No new trial, subscription, or host package mutation ran.

## Published identity

- Desktop **0.4.0**, bundled Shell **0.9.0**.
- Source `dd019377cc3975171dd783c6bb71d9ffa20ab6cd`; tree
  `8c2e1e761b953aca2294461790582b1f5cddd05e`.
- Signed tag `v0.4.0`, verified against the configured public signing identity
  `SHA256:ZiI2Wg/mysTHrZjR2fAMpctJm72/ORqRi/FrGt6bUe4`.
- Original candidate run `34170884999`, attempt 1, artifact `10035864998`.
- Accepted manifest SHA-256
  `32a536b52c108fb19e69b72d7a2c15c3fef2449fe27b01d05b899f62ad2151fb`.
- Protected publication run [34308830976](https://github.com/mirafold/mirafold-desktop/actions/runs/34308830976),
  attempt 1, successful. It selected the retained candidate and published its
  original files. Build, APT signing, and attestation jobs were skipped.
- Public latest [v0.4.0](https://github.com/mirafold/mirafold-desktop/releases/tag/v0.4.0),
  release ID `385214372`, stable with exactly 17 assets.

## Verification and limits

All 17 public asset sizes and SHA-256 digests equal the accepted manifest.
An isolated APT client authenticated the public HTTPS latest-release index and
anonymously downloaded `mirafold-desktop_0.4.0_amd64.deb`; its SHA-256 is
`4001582a273bb9ae7971d0396ef9fcc92112bece14b579493ee11274482415b8`, identical to
the installed accepted package. This is public index/download proof, not a
second installation or a new clean-machine acceptance result.

The retained official GitHub CLI 2.100.0 verified the downloaded Debian package's
signed SLSA provenance, constrained to the canonical repository, Release
workflow, exact source/signer commit, main source ref, and GitHub-hosted runner.
All 17 subjects in that authenticated statement match the accepted manifest;
its invocation is the original candidate run's first attempt. The default
installed CLI lacks this command; no new verifier or application dependency
was installed.

Before publication all retained file hashes, approved APT signature, live
main/next identities, successful original run, unexpired artifact, installed
0.4.0 version, and disabled automation were rechecked. Seven production
page/script responses, including ordinary pay/welcome and private activation,
still matched reviewed site source; three synthetic-invalid API probes returned
the expected refusals. These checks created no billing customer or grant.

## Release reconciliation

Live main and next already had exactly the same accepted source tree, verified
by GitHub commit-tree identities and local tree comparison. Their different
commit hashes are expected under the documented squash-release flow. There is
no content change to carry through a sync PR. The staging hold is closed;
acceptance/release documentation can now land in next through the normal PR.
Automated Shell-intake publication remains disabled under the existing DPC.8
policy; this pass did not change repository security or automation settings.
Windows Pro remains separately deferred. Public Linux website positioning is
unblocked and expressly authorized in the current conversation.

Detailed evidence is retained at
`/home/serrecchia/Projects/mirafold-desktop-dpc12-evidence/`.
