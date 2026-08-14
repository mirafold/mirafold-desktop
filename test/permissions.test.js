import { test } from "node:test";
import assert from "node:assert/strict";
import { installPermissionGuards } from "../src/permissions.js";

test("both Electron permission paths are installed and deny every request", () => {
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

  installPermissionGuards(session);

  assert.equal(checkInstallations, 1);
  assert.equal(requestInstallations, 1);
  assert.equal(typeof checkHandler, "function");
  assert.equal(typeof requestHandler, "function");

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

    let response = null;
    requestHandler({}, permission, (allowed) => {
      response = allowed;
    }, {});
    assert.equal(response, false, `permission request: ${permission}`);
  }
});
