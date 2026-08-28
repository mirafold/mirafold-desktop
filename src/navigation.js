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
 * Reduce the private URL reported by the daemon to the one web origin this
 * window may trust. Require the explicit IPv4-loopback-and-port form emitted
 * by the daemon before letting URL canonicalization reduce it to an origin;
 * accepting anything broader here would turn a child-process startup message
 * into a general navigation allowlist.
 *
 * @param {string} rawUrl URL reported by the daemon
 * @returns {string|null} canonical origin, or null when the URL is not a
 *   Mirafold loopback URL
 */
export function daemonOriginFromUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\//.test(rawUrl)) return null;
  try {
    const target = new URL(rawUrl);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") return null;
    return target.origin;
  } catch {
    return null;
  }
}

/**
 * @param {string} rawUrl the navigation target
 * @param {string} loadingFile absolute path of the loading screen
 * @param {string|null} daemonOrigin canonical origin returned by
 *   daemonOriginFromUrl for the current daemon
 * @returns {"allow"|"external"|"block"}
 */
export function navigationVerdict(rawUrl, loadingFile, daemonOrigin = null) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return "block"; // unparseable: not something to hand onwards
  }

  // This launch's daemon — not every process that happens to listen on the
  // machine's loopback interface.
  if (daemonOrigin !== null && target.origin === daemonOrigin) return "allow";

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

/**
 * Decide what Desktop should do with a request for a new renderer window.
 * Shell's status-bar control uses exactly `/?new=1` (plus an optional fragment
 * carrying its relay handoff), and that is the only popup Desktop folds back
 * into its one window. Every other web popup belongs in the system browser,
 * including same-origin links rendered from agent output. A form submission is
 * refused because opening only its URL would silently discard the POST body.
 *
 * @param {string} rawUrl resolved popup URL supplied by Electron
 * @param {string|null} daemonOrigin active daemon's canonical origin
 * @param {boolean} hasPostBody whether Electron supplied form POST data
 * @returns {"same-window"|"external"|"block"}
 */
export function popupVerdict(rawUrl, daemonOrigin = null, hasPostBody = false) {
  if (hasPostBody) return "block";

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return "block";
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") return "block";
  if (
    daemonOrigin !== null
    && target.origin === daemonOrigin
    && target.username === ""
    && target.password === ""
    && target.pathname === "/"
    && target.search === "?new=1"
  ) {
    return "same-window";
  }
  return "external";
}
