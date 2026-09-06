// Isolated native-browser activation for Mirafold Pro.
//
// This module deliberately imports neither Electron nor application lifecycle
// code. Electron main will inject the system-browser opener and the encrypted
// Pro store in a later integration step. Keeping the network and state machine
// here makes the loopback, PKCE, retry, and shutdown boundaries independently
// attackable.

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { createServer as nodeCreateServer } from "node:http";
import { TextDecoder } from "node:util";
import {
  MAX_PENDING_LIFETIME_MS,
  PRO_STORE_VERSION,
} from "./pro-store.js";

export const PRO_ACTIVATION_ORIGIN = "https://mirafold.com";
export const PRO_ACTIVATION_PATH = "/activate";
export const PRO_EXCHANGE_PATH = "/api/desktop/exchange";
export const PRO_CALLBACK_PATH = "/mirafold/desktop/callback";
export const PRO_CALLBACK_LISTENER_DEADLINE_MS = 15 * 60 * 1000;
export const PRO_EXCHANGE_DEADLINE_MS = 15 * 1000;
export const PRO_CALLBACK_MAX_HEADER_BYTES = 8 * 1024;
export const PRO_EXCHANGE_MAX_RESPONSE_BYTES = 256;

const LOOPBACK_HOST = "127.0.0.1";
const MIN_CALLBACK_PORT = 1024;
const MAX_CALLBACK_PORT = 65535;
const CALLBACK_HEADER_DEADLINE_MS = 5 * 1000;
const CALLBACK_SOCKET_DEADLINE_MS = PRO_EXCHANGE_DEADLINE_MS + 5 * 1000;
const MAX_CALLBACK_CONNECTIONS = 8;
const MAX_CALLBACK_HEADER_COUNT = 32;
const TOKEN_BYTES = 32;
const LICENSE_KEY = /^mf_[a-z2-7]{20,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ENVELOPE_FIELDS = ["version", "licenseKey", "pending"];
const PENDING_FIELDS = [
  "version",
  "callbackPort",
  "callbackNonce",
  "state",
  "codeChallenge",
  "verifier",
  "createdAtMs",
  "expiresAtMs",
];

const ERROR_MESSAGES = Object.freeze({
  busy: "Mirafold Pro activation is already in progress.",
  pending: "Mirafold Pro already has an unfinished activation.",
  store: "Mirafold Pro activation state could not be prepared safely.",
  listener: "Mirafold Pro could not start its private local callback.",
  "port-unavailable": "Mirafold Pro's saved callback port is unavailable.",
  browser: "Mirafold Pro could not open the activation page.",
  timeout: "Mirafold Pro activation timed out.",
  expired: "Mirafold Pro activation expired.",
  shutdown: "Mirafold Pro activation stopped.",
  unavailable: "Mirafold Pro activation is temporarily unavailable.",
});

const SUCCESS_PAGE = Buffer.from(
  "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">"
  + "<title>Mirafold Pro connected</title><main><h1>Mirafold Pro connected</h1>"
  + "<p>You can close this page and return to Mirafold.</p></main>",
);
const FAILURE_PAGE = Buffer.from(
  "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">"
  + "<title>Mirafold Pro activation</title><main><h1>Activation was not completed</h1>"
  + "<p>Return to Mirafold and try again.</p></main>",
);

export class ProActivationError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? "Mirafold Pro activation failed.");
    this.name = "ProActivationError";
    this.code = code;
  }
}

const fail = (code) => new ProActivationError(code);

function hasExactFields(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.includes(key))
    && required.every((field) => keys.includes(field));
}

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw fail("unavailable");
  }
  if (!isSafeTimestamp(value)) throw fail("unavailable");
  return value;
}

function isCallbackPort(value) {
  return Number.isInteger(value) && value >= MIN_CALLBACK_PORT && value <= MAX_CALLBACK_PORT;
}

function isB64url256(value) {
  if (typeof value !== "string" || !TOKEN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === TOKEN_BYTES && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function challengeFor(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function normalizePending(value) {
  if (
    !hasExactFields(value, PENDING_FIELDS)
    || value.version !== PRO_STORE_VERSION
    || !isCallbackPort(value.callbackPort)
    || !isB64url256(value.callbackNonce)
    || !isB64url256(value.state)
    || !isB64url256(value.codeChallenge)
    || !isB64url256(value.verifier)
    || value.codeChallenge !== challengeFor(value.verifier)
    || !isSafeTimestamp(value.createdAtMs)
    || !isSafeTimestamp(value.expiresAtMs)
    || value.expiresAtMs <= value.createdAtMs
    || value.expiresAtMs - value.createdAtMs > MAX_PENDING_LIFETIME_MS
  ) {
    return null;
  }
  return Object.freeze({
    version: PRO_STORE_VERSION,
    callbackPort: value.callbackPort,
    callbackNonce: value.callbackNonce,
    state: value.state,
    codeChallenge: value.codeChallenge,
    verifier: value.verifier,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
  });
}

function samePending(left, right) {
  return left !== null
    && right !== null
    && PENDING_FIELDS.every((field) => left[field] === right[field]);
}

function normalizeEnvelope(value) {
  if (value === null) return null;
  if (!hasExactFields(value, ENVELOPE_FIELDS, ["version"])) return null;
  if (value.version !== PRO_STORE_VERSION) return null;
  const hasLicenseKey = Object.hasOwn(value, "licenseKey");
  const hasPending = Object.hasOwn(value, "pending");
  if (!hasLicenseKey && !hasPending) return null;
  if (hasLicenseKey && (typeof value.licenseKey !== "string" || !LICENSE_KEY.test(value.licenseKey))) {
    return null;
  }
  const pending = hasPending ? normalizePending(value.pending) : undefined;
  if (hasPending && pending === null) return null;

  const envelope = { version: PRO_STORE_VERSION };
  if (hasLicenseKey) envelope.licenseKey = value.licenseKey;
  if (hasPending) envelope.pending = pending;
  return Object.freeze(envelope);
}

function normalizeSiteOrigin(value) {
  if (value === PRO_ACTIVATION_ORIGIN) return value;
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(value)) {
    throw new TypeError("site origin must be Mirafold production or an explicit test loopback origin");
  }
  const target = new URL(value);
  if (!isCallbackPort(Number(target.port)) || target.origin !== value) {
    throw new TypeError("test site origin must use a canonical unprivileged loopback port");
  }
  return value;
}

function randomToken(randomBytes) {
  let bytes;
  try {
    bytes = randomBytes(TOKEN_BYTES);
    if (!Buffer.isBuffer(bytes) || bytes.length !== TOKEN_BYTES) throw new Error("invalid bytes");
    return bytes.toString("base64url");
  } catch {
    throw fail("unavailable");
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}

/**
 * Generate the exact pending record and browser request after the listener has
 * supplied its port. Verifier, state, and callback path each receive distinct
 * 256-bit randomness; only the S256 challenge derived from the verifier leaves
 * Electron main. The browser URL itself contains callback capabilities and
 * must never be logged.
 */
export function createActivationRequest({
  callbackPort,
  siteOrigin = PRO_ACTIVATION_ORIGIN,
  now = Date.now,
  randomBytes = nodeRandomBytes,
} = {}) {
  if (!isCallbackPort(callbackPort)) throw new TypeError("an unprivileged callback port is required");
  if (typeof now !== "function" || typeof randomBytes !== "function") {
    throw new TypeError("clock and randomness adapters are required");
  }
  const origin = normalizeSiteOrigin(siteOrigin);
  const createdAtMs = safeNow(now);
  if (createdAtMs > Number.MAX_SAFE_INTEGER - MAX_PENDING_LIFETIME_MS) {
    throw fail("unavailable");
  }
  const verifier = randomToken(randomBytes);
  const pending = Object.freeze({
    version: PRO_STORE_VERSION,
    callbackPort,
    callbackNonce: randomToken(randomBytes),
    state: randomToken(randomBytes),
    codeChallenge: challengeFor(verifier),
    verifier,
    createdAtMs,
    expiresAtMs: createdAtMs + MAX_PENDING_LIFETIME_MS,
  });
  return Object.freeze({
    pending,
    activationUrl: activationUrlForPending(pending, origin),
  });
}

/** Build the canonical browser URL for a valid pending flow. Never log it. */
export function activationUrlForPending(pendingValue, siteOrigin = PRO_ACTIVATION_ORIGIN) {
  const pending = normalizePending(pendingValue);
  if (!pending) throw new TypeError("a valid pending activation is required");
  const origin = normalizeSiteOrigin(siteOrigin);
  const parameters = new URLSearchParams([
    ["version", String(PRO_STORE_VERSION)],
    ["callback_port", String(pending.callbackPort)],
    ["callback_nonce", pending.callbackNonce],
    ["state", pending.state],
    ["code_challenge", pending.codeChallenge],
  ]);
  return `${origin}${PRO_ACTIVATION_PATH}?${parameters.toString()}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A failed browser open can end a session before its handle reaches a caller.
  // Mark the rejection observed while keeping the original Promise rejectable.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function safeError(error, fallback) {
  return error instanceof ProActivationError ? error : fail(fallback);
}

function responseHeaders(body) {
  return {
    "cache-control": "no-store",
    connection: "close",
    "content-length": String(body.length),
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function writePage(response, status, body) {
  try {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, responseHeaders(body));
    response.end(body);
  } catch {
    try {
      response.destroy();
    } catch {
      // A disconnected browser cannot change the activation result.
    }
  }
}

function rawFailureResponse() {
  const headers = responseHeaders(FAILURE_PAGE);
  const lines = ["HTTP/1.1 400 Bad Request"];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), FAILURE_PAGE]);
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Cancellation is best-effort; the response is already unusable.
  }
}

async function readBoundedResponse(response, maxBytes) {
  const declared = response?.headers?.get?.("content-length") ?? null;
  let expected = null;
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^[0-9]+$/.test(normalized)) {
      await cancelResponseBody(response);
      return null;
    }
    expected = Number(normalized);
    if (!Number.isSafeInteger(expected) || expected > maxBytes) {
      await cancelResponseBody(response);
      return null;
    }
  }
  if (!response?.body || typeof response.body.getReader !== "function") return null;

  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  let reader;
  try {
    reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > maxBytes - size) {
        await reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    if (expected !== null && expected !== size) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } catch {
    return null;
  } finally {
    bytes.fill(0);
    try {
      reader?.releaseLock();
    } catch {
      // A canceled or hostile response is still only an invalid response.
    }
  }
}

function exactCallbackCode(request, pending) {
  if (
    request?.method !== "GET"
    || request.httpVersion !== "1.1"
    || !Array.isArray(request.rawHeaders)
    || request.rawHeaders.length % 2 !== 0
    || request.rawHeaders.length / 2 > MAX_CALLBACK_HEADER_COUNT
    || request.headers?.["content-length"] !== undefined
    || request.headers?.["transfer-encoding"] !== undefined
    || typeof request.url !== "string"
  ) {
    return null;
  }

  const hosts = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "host") hosts.push(request.rawHeaders[index + 1]);
  }
  const expectedHost = `${LOOPBACK_HOST}:${pending.callbackPort}`;
  if (hosts.length !== 1 || hosts[0] !== expectedHost || request.headers.host !== expectedHost) {
    return null;
  }

  const prefix = `${PRO_CALLBACK_PATH}/${pending.callbackNonce}?code=`;
  const suffix = `&state=${pending.state}`;
  if (!request.url.startsWith(prefix) || !request.url.endsWith(suffix)) return null;
  const code = request.url.slice(prefix.length, -suffix.length);
  return isB64url256(code) ? code : null;
}

/**
 * Create one serialized activation controller. `start()` creates and opens a
 * new flow; `resume()` re-binds only the exact stored flow without opening a
 * browser. Both return a handle whose `result` resolves to one in-memory key.
 * `shutdown()` permanently retires this controller after all active startup
 * work has settled.
 */
export function createProActivationController({
  store,
  openBrowser,
  fetch: fetchImpl = globalThis.fetch,
  createServer = nodeCreateServer,
  siteOrigin = PRO_ACTIVATION_ORIGIN,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  setTimeout: setTimeoutImpl = globalThis.setTimeout,
  clearTimeout: clearTimeoutImpl = globalThis.clearTimeout,
  callbackDeadlineMs = PRO_CALLBACK_LISTENER_DEADLINE_MS,
  exchangeDeadlineMs = PRO_EXCHANGE_DEADLINE_MS,
} = {}) {
  if (
    !store
    || typeof store.load !== "function"
    || typeof store.save !== "function"
    || typeof store.remove !== "function"
  ) {
    throw new TypeError("encrypted Pro store adapter is required");
  }
  if (
    typeof openBrowser !== "function"
    || typeof fetchImpl !== "function"
    || typeof createServer !== "function"
    || typeof now !== "function"
    || typeof randomBytes !== "function"
    || typeof setTimeoutImpl !== "function"
    || typeof clearTimeoutImpl !== "function"
  ) {
    throw new TypeError("activation capability adapters are required");
  }
  if (
    !Number.isInteger(callbackDeadlineMs)
    || callbackDeadlineMs <= 0
    || callbackDeadlineMs > PRO_CALLBACK_LISTENER_DEADLINE_MS
    || !Number.isInteger(exchangeDeadlineMs)
    || exchangeDeadlineMs <= 0
    || exchangeDeadlineMs > PRO_EXCHANGE_DEADLINE_MS
  ) {
    throw new TypeError("activation deadlines exceed their fixed bounds");
  }
  const origin = normalizeSiteOrigin(siteOrigin);
  const exchangeUrl = `${origin}${PRO_EXCHANGE_PATH}`;
  let active = null;
  let closed = false;
  let operationInProgress = false;
  let operationPromise = null;

  const serialize = (operation) => {
    if (operationInProgress) return Promise.reject(fail("busy"));
    operationInProgress = true;
    const result = Promise.resolve().then(operation).finally(() => {
      operationInProgress = false;
      operationPromise = null;
    });
    operationPromise = result.catch(() => {});
    return result;
  };

  async function loadEnvelope() {
    try {
      const raw = await store.load();
      const envelope = normalizeEnvelope(raw);
      if (raw !== null && envelope === null) throw new Error("invalid store result");
      return envelope;
    } catch {
      throw fail("store");
    }
  }

  async function clearExactPending(expected) {
    let current = await loadEnvelope();
    if (!current?.pending || !samePending(current.pending, expected)) return current;
    try {
      if (current.licenseKey) {
        await store.save({ version: PRO_STORE_VERSION, licenseKey: current.licenseKey });
      } else {
        await store.remove();
      }
    } catch {
      throw fail("store");
    }
    current = await loadEnvelope();
    if (current?.pending && samePending(current.pending, expected)) throw fail("store");
    return current;
  }

  async function currentEnvelope() {
    let current = await loadEnvelope();
    if (!current?.pending) return current;
    const nowMs = safeNow(now);
    if (current.pending.createdAtMs > nowMs) throw fail("store");
    if (current.pending.expiresAtMs <= nowMs) current = await clearExactPending(current.pending);
    return current;
  }

  function clearSessionTimer(session) {
    if (session.timer === null) return;
    try {
      clearTimeoutImpl(session.timer);
    } catch {
      // Timer cleanup cannot resurrect a listener or expose its secrets.
    }
    session.timer = null;
  }

  function stopAccepting(session, keepSocket = null) {
    if (session.closing) return;
    session.closing = true;
    clearSessionTimer(session);
    try {
      session.server.close(() => {});
    } catch {
      // The server may already have closed after a transport failure.
    }
    for (const socket of session.sockets) {
      if (socket === keepSocket) continue;
      try {
        socket.destroy();
      } catch {
        // Closing the server still prevents new callback requests.
      }
    }
  }

  async function forceClose(session) {
    clearSessionTimer(session);
    session.closing = true;
    const exchangeDone = session.exchangeDone;
    try {
      session.cancelExchange?.();
    } catch {
      // The abort signal below independently cancels the real fetch transport.
    }
    try {
      session.abortController?.abort();
    } catch {
      // The fetch race below still has its own fixed deadline.
    }
    for (const socket of session.sockets) {
      try {
        socket.destroy();
      } catch {
        // Continue closing every remaining callback transport.
      }
    }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        session.server.close(done);
        if (!session.server.listening) done();
      } catch {
        done();
      }
    });
    await exchangeDone;
  }

  async function terminate(session, code, clearExpired = false) {
    if (active !== session) return false;
    if (session.termination !== null) {
      await session.termination;
      return false;
    }
    session.ended = true;
    session.endCode = code;
    session.termination = Promise.resolve().then(async () => {
      await forceClose(session);
      let resultCode = code;
      if (clearExpired && session.pending !== null) {
        try {
          await clearExactPending(session.pending);
        } catch {
          resultCode = "store";
        }
      }
      session.endCode = resultCode;
      if (active === session) active = null;
      session.deferred.reject(fail(resultCode));
    });
    await session.termination;
    return true;
  }

  function scheduleSessionDeadline(session) {
    const remaining = session.pending.expiresAtMs - safeNow(now);
    if (remaining <= 0) throw fail("expired");
    const delay = Math.min(callbackDeadlineMs, remaining);
    session.timer = setTimeoutImpl(() => {
      void (async () => {
        if (active !== session || session.ended) return;
        let expired = false;
        try {
          expired = safeNow(now) >= session.pending.expiresAtMs;
        } catch {
          await terminate(session, "unavailable");
          return;
        }
        await terminate(session, expired ? "expired" : "timeout", expired);
      })().catch(() => {});
    }, delay);
  }

  async function exchange(session, code) {
    const controller = new AbortController();
    let cancelExchange;
    const cancellationPromise = new Promise((resolve) => {
      cancelExchange = () => resolve(null);
    });
    let resolveExchangeDone;
    const exchangeDone = new Promise((resolve) => {
      resolveExchangeDone = resolve;
    });
    session.abortController = controller;
    session.cancelExchange = cancelExchange;
    session.exchangeDone = exchangeDone;
    let deadline;
    const deadlinePromise = new Promise((_, reject) => {
      deadline = setTimeoutImpl(() => {
        try {
          controller.abort();
        } catch {
          // Promise.race still enforces the caller-visible bound.
        }
        reject(fail("unavailable"));
      }, exchangeDeadlineMs);
    });
    deadlinePromise.catch(() => {});

    const body = JSON.stringify({ code, verifier: session.pending.verifier });
    const request = (async () => {
      const response = await fetchImpl(exchangeUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body,
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (
        response?.status !== 200
        || response.redirected !== false
        || response.url !== exchangeUrl
        || response.headers?.get?.("content-type")?.trim().toLowerCase() !== "application/json"
      ) {
        await cancelResponseBody(response);
        return null;
      }
      const payload = await readBoundedResponse(response, PRO_EXCHANGE_MAX_RESPONSE_BYTES);
      if (payload === null) return null;
      const match = /^\{\"licenseKey\":\"(mf_[a-z2-7]{20,40})\"\}$/.exec(payload);
      return match ? match[1] : null;
    })();
    request.catch(() => {});
    try {
      return await Promise.race([request, deadlinePromise, cancellationPromise]);
    } catch {
      return null;
    } finally {
      if (deadline !== undefined) {
        try {
          clearTimeoutImpl(deadline);
        } catch {
          // The fixed race has already settled; abort below keeps a broken
          // injected timer adapter from leaving the request authoritative.
          try {
            controller.abort();
          } catch {
            // The response will still be validated before use.
          }
        }
      }
      session.abortController = null;
      session.cancelExchange = null;
      session.exchangeDone = null;
      resolveExchangeDone();
    }
  }

  async function handleCallback(session, request, response) {
    if (active !== session || session.ended || session.pending === null) {
      writePage(response, 400, FAILURE_PAGE);
      return;
    }
    let nowMs;
    try {
      nowMs = safeNow(now);
    } catch {
      writePage(response, 400, FAILURE_PAGE);
      await terminate(session, "unavailable");
      return;
    }
    if (nowMs >= session.pending.expiresAtMs) {
      writePage(response, 400, FAILURE_PAGE);
      await terminate(session, "expired", true);
      return;
    }

    const code = exactCallbackCode(request, session.pending);
    if (code === null || session.exchangeInFlight) {
      writePage(response, 400, FAILURE_PAGE);
      return;
    }

    session.exchangeInFlight = true;
    const licenseKey = await exchange(session, code);
    session.exchangeInFlight = false;
    if (active !== session || session.ended) return;
    if (licenseKey === null) {
      writePage(response, 502, FAILURE_PAGE);
      return;
    }

    session.ended = true;
    session.completed = true;
    active = null;
    stopAccepting(session, response.socket);
    writePage(response, 200, SUCCESS_PAGE);
    session.deferred.resolve(licenseKey);
  }

  function buildServer(session) {
    let server;
    try {
      server = createServer({
        connectionsCheckingInterval: 1000,
        headersTimeout: CALLBACK_HEADER_DEADLINE_MS,
        keepAliveTimeout: 1,
        maxHeaderSize: PRO_CALLBACK_MAX_HEADER_BYTES,
        requestTimeout: CALLBACK_HEADER_DEADLINE_MS,
        requireHostHeader: true,
      }, (request, response) => {
        void handleCallback(session, request, response).catch(() => {
          writePage(response, 500, FAILURE_PAGE);
          void terminate(session, "listener").catch(() => {});
        });
      });
    } catch {
      throw fail("listener");
    }
    if (
      !server
      || typeof server.listen !== "function"
      || typeof server.close !== "function"
      || typeof server.on !== "function"
    ) {
      throw fail("listener");
    }
    server.maxConnections = MAX_CALLBACK_CONNECTIONS;
    server.maxHeadersCount = MAX_CALLBACK_HEADER_COUNT;
    server.maxRequestsPerSocket = 1;
    server.setTimeout?.(CALLBACK_SOCKET_DEADLINE_MS, (socket) => socket.destroy());
    server.on("connection", (socket) => {
      session.sockets.add(socket);
      socket.once("close", () => session.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      try {
        if (!socket.destroyed && socket.writable) socket.end(rawFailureResponse());
      } catch {
        socket.destroy();
      }
    });
    server.on("error", () => {
      if (!session.binding && active === session && !session.closing) {
        void terminate(session, "listener").catch(() => {});
      }
    });
    return server;
  }

  async function bind(port) {
    const session = {
      abortController: null,
      activationUrl: null,
      binding: true,
      closing: false,
      completed: false,
      deferred: deferred(),
      ended: false,
      endCode: null,
      cancelExchange: null,
      exchangeDone: null,
      exchangeInFlight: false,
      pending: null,
      server: null,
      sockets: new Set(),
      timer: null,
      termination: null,
    };
    session.server = buildServer(session);
    active = session;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          session.server.off("listening", onListening);
          session.server.off("close", onClose);
          reject(error);
        };
        const onClose = () => {
          session.server.off("error", onError);
          session.server.off("listening", onListening);
          reject(fail(session.endCode ?? "listener"));
        };
        const onListening = () => {
          session.server.off("error", onError);
          session.server.off("close", onClose);
          resolve();
        };
        session.server.once("error", onError);
        session.server.once("close", onClose);
        session.server.once("listening", onListening);
        session.server.listen({
          exclusive: true,
          host: LOOPBACK_HOST,
          port,
        });
      });
      session.binding = false;
      const address = session.server.address();
      if (
        !address
        || typeof address === "string"
        || address.address !== LOOPBACK_HOST
        || !isCallbackPort(address.port)
        || (port !== 0 && address.port !== port)
      ) {
        throw fail("listener");
      }
      return { session, port: address.port };
    } catch (error) {
      session.binding = false;
      if (session.termination !== null) {
        await session.termination;
        throw fail(session.endCode ?? "shutdown");
      }
      if (active === session) active = null;
      await forceClose(session);
      if (port !== 0 && (error?.code === "EADDRINUSE" || error?.code === "EACCES")) {
        throw fail("port-unavailable");
      }
      throw safeError(error, "listener");
    }
  }

  function publicHandle(session) {
    return Object.freeze({
      activationUrl: session.activationUrl,
      result: session.deferred.promise,
    });
  }

  async function persistPending(current, pending) {
    const next = { version: PRO_STORE_VERSION };
    if (current?.licenseKey) next.licenseKey = current.licenseKey;
    next.pending = pending;
    try {
      await store.save(next);
    } catch {
      throw fail("store");
    }
    const readBack = await loadEnvelope();
    if (
      !readBack?.pending
      || !samePending(readBack.pending, pending)
      || Object.hasOwn(readBack, "licenseKey") !== Object.hasOwn(next, "licenseKey")
      || readBack.licenseKey !== next.licenseKey
    ) {
      throw fail("store");
    }
  }

  async function startRaw() {
    if (closed) throw fail("shutdown");
    if (active) throw fail("busy");
    const current = await currentEnvelope();
    if (closed) throw fail("shutdown");
    if (current?.pending) throw fail("pending");

    const { session, port } = await bind(0);
    try {
      if (closed || active !== session || session.ended) {
        throw fail(session.endCode ?? "shutdown");
      }
      const request = createActivationRequest({
        callbackPort: port,
        now,
        randomBytes,
        siteOrigin: origin,
      });
      session.pending = request.pending;
      session.activationUrl = request.activationUrl;
      scheduleSessionDeadline(session);
      await persistPending(current, session.pending);
      if (active !== session || session.ended) throw fail(session.endCode ?? "shutdown");
      const opening = Promise.resolve().then(() => openBrowser(session.activationUrl));
      opening.catch(() => {});
      try {
        await Promise.race([opening, session.deferred.promise]);
      } catch (error) {
        if (session.completed) return publicHandle(session);
        if (active !== session || session.ended) throw fail(session.endCode ?? "shutdown");
        throw error;
      }
      if (!session.completed && (active !== session || session.ended)) {
        throw fail(session.endCode ?? "shutdown");
      }
      return publicHandle(session);
    } catch (error) {
      const mapped = safeError(error, "browser");
      if (active === session) {
        await terminate(session, mapped.code);
      }
      if (session.ended && session.endCode !== null) throw fail(session.endCode);
      throw mapped;
    }
  }

  async function resumeRaw() {
    if (closed) throw fail("shutdown");
    if (active) throw fail("busy");
    const current = await currentEnvelope();
    if (closed) throw fail("shutdown");
    if (!current?.pending) return null;

    const { session } = await bind(current.pending.callbackPort);
    try {
      if (closed || active !== session || session.ended) {
        throw fail(session.endCode ?? "shutdown");
      }
      session.pending = current.pending;
      session.activationUrl = activationUrlForPending(current.pending, origin);
      scheduleSessionDeadline(session);
      return publicHandle(session);
    } catch (error) {
      const mapped = safeError(error, "listener");
      if (active === session) {
        await terminate(session, mapped.code, mapped.code === "expired");
      }
      if (session.ended && session.endCode !== null) throw fail(session.endCode);
      throw mapped;
    }
  }

  async function shutdownRaw() {
    closed = true;
    const session = active;
    const pendingOperation = operationPromise;
    if (session) await terminate(session, "shutdown");
    await pendingOperation;
    return session !== null;
  }

  return Object.freeze({
    start: () => (closed ? Promise.reject(fail("shutdown")) : serialize(startRaw)),
    resume: () => (closed ? Promise.reject(fail("shutdown")) : serialize(resumeRaw)),
    shutdown: shutdownRaw,
  });
}
