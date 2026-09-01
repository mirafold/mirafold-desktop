import { test } from "node:test";
import assert from "node:assert/strict";
import { installPermissionGuards } from "../src/permissions.js";

function capturePermissionHandlers(options) {
  let checkHandler = null;
  let requestHandler = null;
  let checkInstallations = 0;
  let requestInstallations = 0;

  const session = {
    setPermissionCheckHandler(handler) {
      checkInstallations += 1;
      checkHandler = handler;
    },
    setPermissionRequestHandler(handler) {
      requestInstallations += 1;
      requestHandler = handler;
    },
  };

  installPermissionGuards(session, options);

  assert.equal(checkInstallations, 1);
  assert.equal(requestInstallations, 1);
  assert.equal(typeof checkHandler, "function");
  assert.equal(typeof requestHandler, "function");

  return { checkHandler, requestHandler };
}

function requestDecision(requestHandler, webContents, permission, details) {
  let response = null;
  requestHandler(webContents, permission, (allowed) => {
    response = allowed;
  }, details);
  return response;
}

test("both Electron permission paths default to denying every request", () => {
  const { checkHandler, requestHandler } = capturePermissionHandlers();

  for (const permission of [
    "clipboard-read",
    "clipboard-sanitized-write",
    "geolocation",
    "media",
    "midi",
    "notifications",
    "openExternal",
    "usb",
    "unknown-future-permission",
  ]) {
    assert.equal(
      checkHandler(null, permission, "http://127.0.0.1:31337", {}),
      false,
      `permission check: ${permission}`,
    );

    assert.equal(
      requestDecision(requestHandler, {}, permission, {}),
      false,
      `permission request: ${permission}`,
    );
  }
});

test("only the active daemon's main frame may use notifications and the sanitized clipboard write", () => {
  const activeWebContents = {};
  const otherWebContents = {};
  let daemonOrigin = null;
  const { checkHandler, requestHandler } = capturePermissionHandlers({
    trustedWebContents: activeWebContents,
    getDaemonOrigin: () => daemonOrigin,
  });
  const currentUrl = "http://127.0.0.1:31337/session/1";
  const currentCheckDetails = { requestingUrl: currentUrl, isMainFrame: true };
  const currentRequestDetails = { requestingUrl: currentUrl, isMainFrame: true };

  assert.equal(
    checkHandler(activeWebContents, "notifications", "http://127.0.0.1:31337/", currentCheckDetails),
    false,
    "the loading screen must not gain notification permission before a daemon is active",
  );

  daemonOrigin = "http://127.0.0.1:31337";
  assert.equal(
    checkHandler(activeWebContents, "notifications", "http://127.0.0.1:31337/", currentCheckDetails),
    true,
    "Electron's trailing-slash requesting origin must normalize to the active daemon origin",
  );
  assert.equal(
    requestDecision(requestHandler, activeWebContents, "notifications", currentRequestDetails),
    true,
  );
  // The shell's copy buttons write the clipboard on a user click through
  // navigator.clipboard.writeText, which Electron gates on this permission.
  for (const [name, decide] of [
    ["check", () => checkHandler(activeWebContents, "clipboard-sanitized-write", "http://127.0.0.1:31337/", currentCheckDetails)],
    ["request", () => requestDecision(requestHandler, activeWebContents, "clipboard-sanitized-write", currentRequestDetails)],
  ]) {
    assert.equal(decide(), true, `clipboard-sanitized-write ${name}: the active daemon's main frame may write`);
  }
  assert.equal(
    checkHandler(otherWebContents, "clipboard-sanitized-write", "http://127.0.0.1:31337/", currentCheckDetails),
    false,
    "another webContents must not inherit the clipboard grant",
  );
  assert.equal(
    checkHandler(activeWebContents, "clipboard-sanitized-write", "http://127.0.0.1:31337/", { requestingUrl: currentUrl, isMainFrame: false }),
    false,
    "a subframe (an artifact, a diagram) must not inherit the clipboard grant",
  );
  assert.equal(
    checkHandler(activeWebContents, "clipboard-sanitized-write", "https://example.com/", { requestingUrl: "https://example.com/", isMainFrame: true }),
    false,
    "an external origin must not inherit the clipboard grant",
  );

  for (const permission of [
    "clipboard-read",
    "geolocation",
    "media",
    "midi",
    "openExternal",
    "usb",
    "unknown-future-permission",
  ]) {
    assert.equal(
      checkHandler(activeWebContents, permission, "http://127.0.0.1:31337/", currentCheckDetails),
      false,
      `permission check must remain denied: ${permission}`,
    );
    assert.equal(
      requestDecision(requestHandler, activeWebContents, permission, currentRequestDetails),
      false,
      `permission request must remain denied: ${permission}`,
    );
  }

  assert.equal(
    checkHandler(otherWebContents, "notifications", "http://127.0.0.1:31337/", currentCheckDetails),
    false,
    "another webContents in the shared session must not inherit the grant",
  );
  assert.equal(
    requestDecision(requestHandler, otherWebContents, "notifications", currentRequestDetails),
    false,
  );
  assert.equal(
    checkHandler(activeWebContents, "notifications", "https://example.com/", {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
    }),
    false,
    "an external origin must not inherit the grant",
  );
  assert.equal(
    requestDecision(requestHandler, activeWebContents, "notifications", {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
    }),
    false,
  );
  assert.equal(
    checkHandler(activeWebContents, "notifications", "http://127.0.0.1:31337/", {
      requestingUrl: currentUrl,
      isMainFrame: false,
    }),
    false,
    "a subframe must not inherit the main frame's grant",
  );
  assert.equal(
    requestDecision(requestHandler, activeWebContents, "notifications", {
      requestingUrl: currentUrl,
      isMainFrame: false,
    }),
    false,
  );

  daemonOrigin = "http://127.0.0.1:41337";
  assert.equal(
    checkHandler(activeWebContents, "notifications", "http://127.0.0.1:31337/", currentCheckDetails),
    false,
    "a prior daemon origin must lose permission after a restart",
  );
  assert.equal(
    requestDecision(requestHandler, activeWebContents, "notifications", currentRequestDetails),
    false,
  );
  const rotatedUrl = "http://127.0.0.1:41337/session/2";
  const rotatedDetails = { requestingUrl: rotatedUrl, isMainFrame: true };
  assert.equal(
    checkHandler(activeWebContents, "notifications", "http://127.0.0.1:41337/", rotatedDetails),
    true,
    "the replacement daemon origin must gain notification permission",
  );
  assert.equal(
    requestDecision(requestHandler, activeWebContents, "notifications", rotatedDetails),
    true,
  );
});
