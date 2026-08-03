// What the window is allowed to load.
//
// Split out of main.js so the rule can be tested without starting Electron —
// it is the only thing standing between "a window showing the daemon" and "a
// window showing whatever a link in agent output points at".
//
// The rule this enforces: the daemon's own pages, and the loading screen.
// Everything else that is a web page opens in the user's real browser, where
// it has an address bar and no relationship to this app. Everything else
// entirely is refused.
//
// Chromium independently refuses to navigate a web page to a file:// URL
// (verified 2026-08-03: both a link click and a location assignment were
// rejected with "Not allowed to load local resource" before this handler even
// ran). That is a good backstop, not a reason to leave the gap open here —
// it is Chromium's rule to change, not ours, and it does not apply to the
// loading screen, which really is a local file.

import { fileURLToPath } from "node:url";

/**
 * @param {string} rawUrl the navigation target
 * @param {string} loadingFile absolute path of the loading screen
 * @returns {"allow"|"external"|"block"}
 */
export function navigationVerdict(rawUrl, loadingFile) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return "block"; // unparseable: not something to hand onwards
  }

  // The daemon. It serves plain HTTP on loopback and nothing else does.
  if (target.protocol === "http:" && target.hostname === "127.0.0.1") return "allow";

  // A real web page — the user's browser owns it.
  if (target.protocol === "http:" || target.protocol === "https:") return "external";

  // Our own loading screen, and no other local file. Reached only if Chromium
  // ever permits a file:// navigation the loading screen initiates.
  if (target.protocol === "file:") {
    try {
      return fileURLToPath(target) === loadingFile ? "allow" : "block";
    } catch {
      return "block";
    }
  }

  // Anything else — a custom scheme, javascript:, mailto:, an OS handler.
  // Never handed to shell.openExternal, which would ask the operating system
  // to act on it.
  return "block";
}
