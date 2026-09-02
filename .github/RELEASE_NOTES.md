## Included versions

- Mirafold Desktop `0.3.12`
- Mirafold Shell `0.8.3`

Desktop 0.3.12 keeps the same application runtime and bundled Shell as 0.3.11.
This release hardens the machinery that proves and publishes Desktop releases.

## What changed

- The automated release coordinator now tolerates GitHub's brief delay
  exposing a newly pushed annotated tag, but only after the reviewed
  candidate's parent, tree, commit identity, and message match exactly. It
  rechecks `main` after the tag appears and still stops if `main` moved.
- Packaged release verification now starts Desktop's real daemon and Gemini
  adapter, initializes the bundled Mirafold renderer MCP, verifies its 18-tool
  contract, calls `render_card`, checks child-only `ELECTRON_RUN_AS_NODE`
  scoping, and proves clean renderer and daemon-tree shutdown.
- The native Windows gate also exercises the complete NSIS install, packaged
  startup, and uninstall lifecycle.

These changes address the release-publication failure observed while producing
Desktop 0.3.11; they do not change Desktop's application runtime behavior.

- Release-coordinator fix: https://github.com/mirafold/mirafold-desktop/pull/45
- Packaged-runtime regression coverage: https://github.com/mirafold/mirafold-desktop/pull/44
- Bundled Shell release: https://github.com/mirafold/mirafold/releases/tag/v0.8.3
