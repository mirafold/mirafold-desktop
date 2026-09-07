/**
 * The short main-process transitions that may own the daemon, the encrypted
 * Pro state, or the activation controller. Keeping the names here makes the
 * coordinator's complete race surface explicit and testable.
 */
export const LIFECYCLE_ACTION = Object.freeze({
  ACTIVATION_START: "activation-start",
  ACTIVATION_COMPLETE: "activation-complete",
  CREDENTIAL_REMOVAL: "credential-removal",
  DAEMON_CRASH: "daemon-crash",
  FOLDER_CHANGE: "folder-change",
  QUIT: "quit",
  RESTART: "restart",
  UPDATE_INSTALL: "update-install",
  UPDATE_RECOVERY: "update-recovery",
});

/**
 * Give every main-process lifecycle transition one asynchronous owner.
 *
 * Operations run in request order, rejected operations never poison the next
 * operation, and a named duplicate shares the first Promise. `close()` marks
 * the coordinator closed synchronously: queued work is retired before it can
 * touch state, the current owner can observe `isClosing()` or await the shared
 * closing signal, and exactly one final cleanup runs after that owner settles.
 */
export function createLifecycleCoordinator() {
  let operationTail = Promise.resolve();
  let owner = null;
  let closing = false;
  let closePromise = null;
  const flights = new Map();
  let releaseClosing;
  const whenClosing = new Promise((resolve) => {
    releaseClosing = resolve;
  });

  function enqueue(kind, operation, { allowClosing = false, dedupeKey = null } = {}) {
    if (typeof kind !== "string" || kind.length === 0 || typeof operation !== "function") {
      throw new TypeError("lifecycle kind and operation are required");
    }
    if (dedupeKey !== null && flights.has(dedupeKey)) return flights.get(dedupeKey);
    if (closing && !allowClosing) return Promise.resolve(undefined);

    let result;
    result = operationTail.then(async () => {
      if (closing && !allowClosing) return undefined;
      owner = kind;
      try {
        return await operation(Object.freeze({
          isClosing: () => closing,
          whenClosing,
        }));
      } finally {
        if (owner === kind) owner = null;
      }
    });
    operationTail = result.catch(() => {});

    if (dedupeKey !== null) {
      flights.set(dedupeKey, result);
      void result.finally(() => {
        if (flights.get(dedupeKey) === result) flights.delete(dedupeKey);
      }).catch(() => {});
    }
    return result;
  }

  return Object.freeze({
    get closing() {
      return closing;
    },
    get owner() {
      return owner;
    },
    get whenClosing() {
      return whenClosing;
    },
    run: (kind, operation, options) => enqueue(kind, operation, options),
    close(kind, operation) {
      if (closePromise) return closePromise;
      closing = true;
      releaseClosing();
      closePromise = enqueue(kind, operation, { allowClosing: true });
      return closePromise;
    },
  });
}

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
