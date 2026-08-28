// The Mirafold page is an ordinary web page. It needs networking to its own
// daemon and the notification grant used by the shell's opt-in operating-system
// notifications, but it does not need Chromium grants such as camera,
// microphone, location, MIDI, USB, or clipboard access.
//
// Keep both Electron permission paths explicit. Electron documents that the
// check and request handlers must be implemented together for a complete
// policy; leaving either one unset delegates part of the decision back to
// Electron's defaults.

/**
 * Install the renderer's default-deny permission policy on a Session. The one
 * grant is notifications from the active daemon's main frame in the active
 * Mirafold window. This small adapter is dependency-free and injectable so the
 * actual handler wiring can be tested without launching Electron.
 *
 * @param {{
 *   setPermissionCheckHandler: (handler: (...args: unknown[]) => boolean) => void,
 *   setPermissionRequestHandler: (handler: (...args: unknown[]) => void) => void,
 * }} electronSession
 * @param {{
 *   trustedWebContents?: unknown,
 *   getDaemonOrigin?: () => string|null,
 * }} [options]
 */
export function installPermissionGuards(electronSession, options = {}) {
  const { trustedWebContents, getDaemonOrigin } = options;

  const allowNotification = (webContents, permission, rawUrls, isMainFrame) => {
    if (
      permission !== "notifications"
      || trustedWebContents == null
      || webContents !== trustedWebContents
      || isMainFrame !== true
      || typeof getDaemonOrigin !== "function"
    ) {
      return false;
    }

    const daemonOrigin = getDaemonOrigin();
    const suppliedUrls = rawUrls.filter((url) => typeof url === "string" && url.length > 0);
    if (daemonOrigin === null || suppliedUrls.length === 0) return false;
    return suppliedUrls.every((rawUrl) => {
      try {
        return new URL(rawUrl).origin === daemonOrigin;
      } catch {
        return false;
      }
    });
  };

  electronSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    allowNotification(
      webContents,
      permission,
      [requestingOrigin, details?.requestingUrl],
      details?.isMainFrame,
    )
  ));
  electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowNotification(
      webContents,
      permission,
      [details?.requestingUrl],
      details?.isMainFrame,
    ));
  });
}
