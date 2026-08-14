/**
 * Gate Electron's synchronous `before-quit` event on asynchronous cleanup.
 *
 * The first quit is prevented while cleanup runs. Calling `finishQuit` starts a
 * second quit event, which is allowed through. Re-entrant quit requests during
 * cleanup share the same Promise and cannot start a second teardown.
 */
export function createBeforeQuitHandler({ beginQuit, stop, finishQuit, reportError }) {
  let cleanupPromise = null;
  let released = false;

  return function handleBeforeQuit(event) {
    if (released) return cleanupPromise ?? Promise.resolve();
    event.preventDefault();
    if (cleanupPromise) return cleanupPromise;

    beginQuit();
    cleanupPromise = (async () => {
      try {
        await stop();
      } catch (error) {
        try {
          reportError?.(error);
        } catch {
          // A diagnostic sink must not strand an application mid-quit.
        }
      }
      released = true;
      finishQuit();
    })();
    return cleanupPromise;
  };
}
