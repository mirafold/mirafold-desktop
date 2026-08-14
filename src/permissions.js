// The Mirafold page is an ordinary web page. It needs networking to its own
// daemon, but it does not need Chromium permission grants such as camera,
// microphone, location, notifications, MIDI, USB, or clipboard access.
//
// Keep both Electron permission paths explicit. Electron documents that the
// check and request handlers must be implemented together for a complete
// policy; leaving either one unset delegates part of the decision back to
// Electron's defaults.

/**
 * Install the complete deny-all renderer permission policy on a Session.
 * This small adapter is dependency-free and injectable so the actual handler
 * wiring can be tested without launching Electron.
 *
 * @param {{
 *   setPermissionCheckHandler: (handler: (...args: unknown[]) => boolean) => void,
 *   setPermissionRequestHandler: (handler: (...args: unknown[]) => void) => void,
 * }} electronSession
 */
export function installPermissionGuards(electronSession) {
  electronSession.setPermissionCheckHandler(() => false);
  electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}
