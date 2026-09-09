## Included versions

- Mirafold Desktop `0.4.1`
- Mirafold Shell `0.9.1`

## What changed

- Session switches open at the end of replayed history, and phone prompts
  wait for a tap before focusing.
- Painting file links open in Files; question details open independently of
  answer submission. Unfinished turns remain visible across reconnects.
- Shell action dispatch, settings replacement, encrypted message handling,
  code fences, and workspace containment are hardened.
- Updated Hono and js-yaml to patched versions, resolving the dependency
  audit failures that blocked Desktop builds and Shell intake.

Windows remains a beta desktop package. This patch does not establish Windows
Pro support or complete the outstanding real-device acceptance checks.
