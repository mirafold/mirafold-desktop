import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRO_ACTIVATION_ORIGIN,
  PRO_CALLBACK_MAX_HEADER_BYTES,
  PRO_CALLBACK_PATH,
  PRO_EXCHANGE_MAX_RESPONSE_BYTES,
  PRO_EXCHANGE_PATH,
  ProActivationError,
  activationUrlForPending,
  createActivationRequest,
  createProActivationController,
} from "../src/pro-activation.js";
import {
  MAX_PENDING_LIFETIME_MS,
  PRO_STORE_VERSION,
  createProStore,
} from "../src/pro-store.js";

const LICENSE_KEY = `mf_${"a".repeat(26)}`;
const RENEWAL_KEY = `mf_${"b".repeat(26)}`;

function token(byte) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function deterministicRandom(...bytes) {
  const buffers = [];
  let index = 0;
  const randomBytes = (size) => {
    assert.equal(size, 32);
    if (index >= bytes.length) throw new Error("deterministic randomness exhausted");
    const buffer = Buffer.alloc(size, bytes[index]);
    buffers.push(buffer);
    index += 1;
    return buffer;
  };
  return { randomBytes, buffers, calls: () => index };
}

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function memoryStore(initial = null, hooks = {}) {
  let record = clone(initial);
  let loads = 0;
  let saves = 0;
  let removes = 0;
  return {
    async load() {
      loads += 1;
      hooks.onLoad?.(loads, clone(record));
      if (hooks.load) return hooks.load(loads, clone(record));
      return clone(record);
    },
    async save(value) {
      saves += 1;
      hooks.onSave?.(saves, clone(value));
      if (hooks.save) await hooks.save(saves, clone(value));
      record = clone(value);
      return clone(record);
    },
    async remove() {
      removes += 1;
      hooks.onRemove?.(removes, clone(record));
      if (hooks.remove) await hooks.remove(removes, clone(record));
      const present = record !== null;
      record = null;
      return present;
    },
    counts: () => ({ loads, saves, removes }),
    snapshot: () => clone(record),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  return address.port;
}

async function closeServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => {
    try {
      server.close(() => resolve());
      if (!server.listening) resolve();
    } catch {
      resolve();
    }
  });
}

async function testServer(t, handler) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  t.after(() => closeServer(server, sockets));
  return { server, port, origin: `http://127.0.0.1:${port}`, sockets };
}

async function readNodeBody(request, maximum = 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= maximum, "test server received an oversized request body");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function callbackParts(activationUrl, code = token(90)) {
  const activation = new URL(activationUrl);
  const callbackPort = Number(activation.searchParams.get("callback_port"));
  const callbackNonce = activation.searchParams.get("callback_nonce");
  const state = activation.searchParams.get("state");
  const pathname = `${PRO_CALLBACK_PATH}/${callbackNonce}`;
  return {
    activation,
    callbackNonce,
    callbackPort,
    code,
    host: `127.0.0.1:${callbackPort}`,
    pathname,
    state,
    url: `http://127.0.0.1:${callbackPort}${pathname}?code=${code}&state=${state}`,
  };
}

function requestCallback(target, options = {}) {
  const parsed = typeof target === "string" ? new URL(target) : null;
  const requestOptions = parsed
    ? {
        hostname: parsed.hostname,
        method: options.method ?? "GET",
        path: `${parsed.pathname}${parsed.search}`,
        port: Number(parsed.port),
        headers: options.headers,
      }
    : target;
  return new Promise((resolve, reject) => {
    const request = http.request(requestOptions, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024) {
          request.destroy(new Error("callback response exceeded test bound"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    request.setTimeout(3000, () => request.destroy(new Error("callback request timed out")));
    request.once("error", reject);
    request.end(options.body);
  });
}

function rawHttp(port, requestText) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.end(requestText);
    });
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.setTimeout(3000, () => socket.destroy(new Error("raw callback timed out")));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, value) => sum + value.length, 0) > 32 * 1024) {
        socket.destroy(new Error("raw callback response exceeded test bound"));
      }
    });
    socket.once("error", reject);
    socket.once("end", done);
    socket.once("close", done);
  });
}

function activationError(code) {
  return (error) => {
    assert.ok(error instanceof ProActivationError);
    assert.equal(error.code, code);
    return true;
  };
}

async function remainsPending(promise, milliseconds = 25) {
  const settled = promise.then(() => true, () => true);
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), milliseconds));
  return (await Promise.race([settled, timeout])) === false;
}

async function waitForListenerClose(activationUrl, milliseconds = 1000) {
  const { callbackPort } = callbackParts(activationUrl);
  const target = `http://127.0.0.1:${callbackPort}/`;
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      await requestCallback(target);
    } catch (error) {
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("callback listener remained reachable past its deadline");
}

function responseFacade(exchangeUrl, body, {
  contentType = "application/json",
  headers = {},
  status = 200,
} = {}) {
  const response = new Response(body, {
    status,
    headers: { "content-type": contentType, ...headers },
  });
  return {
    body: response.body,
    headers: response.headers,
    redirected: false,
    status,
    url: exchangeUrl,
  };
}

test("request generation uses three independent 256-bit values and exact S256/site fields", () => {
  const random = deterministicRandom(1, 2, 3);
  const nowMs = 1_800_000_000_000;
  const request = createActivationRequest({
    callbackPort: 49152,
    now: () => nowMs,
    randomBytes: random.randomBytes,
  });

  assert.equal(random.calls(), 3);
  assert.ok(random.buffers.every((buffer) => buffer.every((byte) => byte === 0)));
  assert.deepEqual(request.pending, {
    version: 1,
    callbackPort: 49152,
    callbackNonce: token(2),
    state: token(3),
    codeChallenge: createHash("sha256").update(token(1), "ascii").digest("base64url"),
    verifier: token(1),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + MAX_PENDING_LIFETIME_MS,
  });
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.pending));
  assert.equal(
    request.activationUrl,
    `${PRO_ACTIVATION_ORIGIN}/activate?version=1&callback_port=49152`
      + `&callback_nonce=${token(2)}&state=${token(3)}`
      + `&code_challenge=${createHash("sha256").update(token(1), "ascii").digest("base64url")}`,
  );
  assert.ok(!request.activationUrl.includes(request.pending.verifier));
});

test("only exact production HTTPS or an explicit canonical test loopback origin is accepted", () => {
  const generated = createActivationRequest({
    callbackPort: 49152,
    now: () => 1,
    randomBytes: deterministicRandom(4, 5, 6).randomBytes,
  });
  assert.equal(
    activationUrlForPending(generated.pending, "http://127.0.0.1:49153"),
    `http://127.0.0.1:49153/activate?${new URL(generated.activationUrl).searchParams}`,
  );

  for (const origin of [
    "http://mirafold.com",
    "https://mirafold.com/",
    "https://mirafold.com:444",
    "https://www.mirafold.com",
    "https://mirafold.com.evil.example",
    "https://user@mirafold.com",
    "http://localhost:49153",
    "http://127.0.0.1",
    "http://127.0.0.1:80",
    "http://127.0.0.1:049153",
    "http://127.0.0.1:49153/path",
    "http://127.0.0.1:49153?query=1",
  ]) {
    assert.throws(() => activationUrlForPending(generated.pending, origin), TypeError, origin);
  }
});

test("listener bind, encrypted save, readback, and browser open occur in that order", async (t) => {
  const events = [];
  let callbackServer;
  let serverOptions;
  const store = memoryStore(null, {
    onLoad: (count) => events.push(`load:${count}`),
    onSave: () => events.push("save"),
  });
  const controller = createProActivationController({
    store,
    openBrowser: async () => events.push("open"),
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    createServer(options, handler) {
      serverOptions = options;
      const server = http.createServer(options, handler);
      callbackServer = server;
      server.once("listening", () => events.push("listening"));
      return server;
    },
    randomBytes: deterministicRandom(7, 8, 9).randomBytes,
  });
  t.after(() => controller.shutdown());

  const handle = await controller.start();
  assert.deepEqual(events, ["load:1", "listening", "save", "load:2", "open"]);
  assert.equal(serverOptions.maxHeaderSize, PRO_CALLBACK_MAX_HEADER_BYTES);
  assert.equal(serverOptions.requireHostHeader, true);
  assert.ok(serverOptions.headersTimeout > 0);
  assert.ok(serverOptions.requestTimeout > 0);
  assert.equal(callbackServer.maxConnections, 8);
  assert.equal(callbackServer.maxHeadersCount, 32);
  assert.equal(callbackServer.maxRequestsPerSocket, 1);
  const saved = store.snapshot();
  assert.equal(saved.pending.callbackPort, callbackParts(handle.activationUrl).callbackPort);
  assert.equal(saved.pending.verifier, token(7));
  assert.ok(!handle.activationUrl.includes(saved.pending.verifier));

  assert.equal(await controller.shutdown(), true);
  await assert.rejects(handle.result, activationError("shutdown"));
  assert.equal(await controller.shutdown(), false);
});

test("a missing or changed readback closes the listener before any browser launch", async () => {
  let opened = 0;
  let callbackPort;
  const store = memoryStore(null, {
    load(count, record) {
      return count === 1 ? record : null;
    },
  });
  const controller = createProActivationController({
    store,
    openBrowser: async () => {
      opened += 1;
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    createServer(options, handler) {
      const server = http.createServer(options, handler);
      server.once("listening", () => {
        const address = server.address();
        if (address && typeof address !== "string") callbackPort = address.port;
      });
      return server;
    },
    randomBytes: deterministicRandom(10, 11, 12).randomBytes,
  });

  await assert.rejects(controller.start(), activationError("store"));
  assert.equal(opened, 0);
  assert.equal(store.counts().saves, 1);
  assert.ok(Number.isInteger(callbackPort));
  await assert.rejects(
    requestCallback(`http://127.0.0.1:${callbackPort}/`),
    (error) => error.code === "ECONNREFUSED" || error.code === "ECONNRESET",
  );
});

test("a failed pending save preserves the prior key and never opens the browser", async () => {
  const initial = { version: PRO_STORE_VERSION, licenseKey: RENEWAL_KEY };
  let attempted;
  let callbackPort;
  let opened = 0;
  const store = memoryStore(initial, {
    onSave: (_count, value) => {
      attempted = value;
    },
    async save() {
      throw new Error("injected write failure");
    },
  });
  const controller = createProActivationController({
    store,
    openBrowser: async () => {
      opened += 1;
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    createServer(options, handler) {
      const server = http.createServer(options, handler);
      server.once("listening", () => {
        const address = server.address();
        if (address && typeof address !== "string") callbackPort = address.port;
      });
      return server;
    },
    randomBytes: deterministicRandom(82, 83, 84).randomBytes,
  });

  await assert.rejects(controller.start(), activationError("store"));
  assert.equal(opened, 0);
  assert.equal(attempted.licenseKey, RENEWAL_KEY);
  assert.ok(attempted.pending);
  assert.deepEqual(store.snapshot(), initial);
  assert.ok(Number.isInteger(callbackPort));
  await assert.rejects(
    requestCallback(`http://127.0.0.1:${callbackPort}/`),
    (error) => error.code === "ECONNREFUSED" || error.code === "ECONNRESET",
  );
});

test("a browser-open failure closes the listener and leaves the exact flow resumable", async () => {
  const store = memoryStore();
  let opened = 0;
  const controller = createProActivationController({
    store,
    openBrowser: async () => {
      opened += 1;
      throw new Error("injected browser failure");
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(107, 108, 109).randomBytes,
  });

  await assert.rejects(controller.start(), activationError("browser"));
  const saved = store.snapshot();
  assert.ok(saved.pending);
  assert.equal(opened, 1);
  const resumed = await controller.resume();
  assert.equal(resumed.activationUrl, activationUrlForPending(saved.pending));
  assert.equal(opened, 1);
  assert.equal(await controller.shutdown(), true);
  await assert.rejects(resumed.result, activationError("shutdown"));
});

test("a malformed or failed store load cannot create a listener", async () => {
  const generated = createActivationRequest({
    callbackPort: 49165,
    now: () => 1,
    randomBytes: deterministicRandom(110, 111, 112).randomBytes,
  });
  const stores = [
    memoryStore({
      version: PRO_STORE_VERSION,
      pending: { ...generated.pending, codeChallenge: token(113) },
    }),
    memoryStore(null, {
      load() {
        throw new Error("injected load failure");
      },
    }),
  ];

  for (const store of stores) {
    let opened = 0;
    let servers = 0;
    const controller = createProActivationController({
      store,
      openBrowser: async () => {
        opened += 1;
      },
      fetch: async () => {
        throw new Error("exchange was not expected");
      },
      createServer() {
        servers += 1;
        throw new Error("listener was not expected");
      },
    });
    await assert.rejects(controller.start(), activationError("store"));
    assert.equal(servers, 0);
    assert.equal(opened, 0);
  }
});

test("the real loopback happy path sends one exact exchange and returns one in-memory key", async (t) => {
  const exchanges = [];
  const site = await testServer(t, async (request, response) => {
    const body = await readNodeBody(request);
    exchanges.push({ body, headers: request.headers, method: request.method, url: request.url });
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ licenseKey: LICENSE_KEY }));
  });
  const store = memoryStore();
  const opened = [];
  const controller = createProActivationController({
    store,
    openBrowser: async (url) => opened.push(url),
    randomBytes: deterministicRandom(13, 14, 15).randomBytes,
    siteOrigin: site.origin,
  });
  t.after(() => controller.shutdown());

  const handle = await controller.start();
  assert.deepEqual(opened, [handle.activationUrl]);
  const parts = callbackParts(handle.activationUrl, token(16));
  const callback = await requestCallback(parts.url);
  assert.equal(callback.status, 200);
  assert.equal(callback.headers["cache-control"], "no-store");
  assert.match(callback.headers["content-security-policy"], /default-src 'none'/);
  assert.doesNotMatch(
    callback.body,
    new RegExp([parts.code, parts.state, store.snapshot().pending.verifier, LICENSE_KEY].join("|")),
  );
  assert.equal(await handle.result, LICENSE_KEY);

  assert.equal(exchanges.length, 1);
  assert.deepEqual(
    { method: exchanges[0].method, url: exchanges[0].url },
    { method: "POST", url: PRO_EXCHANGE_PATH },
  );
  assert.equal(exchanges[0].headers["content-type"], "application/json");
  assert.equal(exchanges[0].headers.origin, undefined);
  assert.equal(exchanges[0].headers.cookie, undefined);
  assert.equal(exchanges[0].headers.authorization, undefined);
  assert.equal(exchanges[0].headers.referer, undefined);
  assert.equal(
    exchanges[0].body,
    JSON.stringify({ code: parts.code, verifier: store.snapshot().pending.verifier }),
  );
  assert.deepEqual(Object.keys(JSON.parse(exchanges[0].body)), ["code", "verifier"]);
  assert.equal(store.snapshot().licenseKey, undefined, "the isolated client must not commit the key");
  assert.ok(store.snapshot().pending, "pending survives until later store-before-restart integration");
  assert.equal(await controller.shutdown(), false);
});

test("wrong method, Host, path, state, query, body, HTTP version, and oversized headers never exchange", async (t) => {
  let exchanges = 0;
  const site = await testServer(t, async (_request, response) => {
    exchanges += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ licenseKey: LICENSE_KEY }));
  });
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async () => {},
    randomBytes: deterministicRandom(17, 18, 19).randomBytes,
    siteOrigin: site.origin,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();
  const valid = callbackParts(handle.activationUrl, token(20));
  const failures = [];

  failures.push(await requestCallback(valid.url, { method: "POST" }));
  failures.push(await requestCallback(valid.url, { headers: { host: `localhost:${valid.callbackPort}` } }));
  failures.push(await requestCallback(
    `http://127.0.0.1:${valid.callbackPort}${PRO_CALLBACK_PATH}/${token(21)}`
      + `?code=${valid.code}&state=${valid.state}`,
  ));
  failures.push(await requestCallback(
    `http://127.0.0.1:${valid.callbackPort}${valid.pathname}`
      + `?code=${valid.code}&state=${token(22)}`,
  ));
  failures.push(await requestCallback(`${valid.url}&extra=1`));
  failures.push(await requestCallback(
    `http://127.0.0.1:${valid.callbackPort}${valid.pathname}`
      + `?state=${valid.state}&code=${valid.code}`,
  ));
  failures.push(await requestCallback(
    `http://127.0.0.1:${valid.callbackPort}${valid.pathname}`
      + `?code=%${valid.code.charCodeAt(0).toString(16)}${valid.code.slice(1)}&state=${valid.state}`,
  ));
  failures.push(await requestCallback(valid.url, {
    body: "x",
    headers: { "content-length": "1" },
  }));

  const rawPath = `${valid.pathname}?code=${valid.code}&state=${valid.state}`;
  const http10 = await rawHttp(
    valid.callbackPort,
    `GET ${rawPath} HTTP/1.0\r\nHost: ${valid.host}\r\n\r\n`,
  );
  const duplicateHost = await rawHttp(
    valid.callbackPort,
    `GET ${rawPath} HTTP/1.1\r\nHost: ${valid.host}\r\nHost: attacker.example\r\n\r\n`,
  );
  const oversized = await rawHttp(
    valid.callbackPort,
    `GET ${rawPath} HTTP/1.1\r\nHost: ${valid.host}\r\nX-Oversized: ${"x".repeat(PRO_CALLBACK_MAX_HEADER_BYTES + 1)}\r\n\r\n`,
  );
  const oversizedQuery = await rawHttp(
    valid.callbackPort,
    `GET ${valid.pathname}?x=${"x".repeat(PRO_CALLBACK_MAX_HEADER_BYTES + 1)} HTTP/1.1\r\n`
      + `Host: ${valid.host}\r\n\r\n`,
  );

  assert.ok(failures.every((response) => response.status === 400));
  assert.equal(new Set(failures.map((response) => response.body)).size, 1);
  for (const raw of [http10, duplicateHost, oversized, oversizedQuery]) {
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.doesNotMatch(raw, new RegExp(`${valid.code}|${valid.state}`));
  }
  assert.equal(exchanges, 0);
  assert.ok(await remainsPending(handle.result));

  const success = await requestCallback(valid.url);
  assert.equal(success.status, 200);
  assert.equal(await handle.result, LICENSE_KEY);
  assert.equal(exchanges, 1);
  await assert.rejects(
    requestCallback(valid.url),
    (error) => error.code === "ECONNREFUSED" || error.code === "ECONNRESET",
  );
  assert.equal(exchanges, 1);
});

test("two simultaneous exact callbacks still authorize only one exchange", async (t) => {
  const received = deferred();
  const release = deferred();
  let exchanges = 0;
  const site = await testServer(t, async (_request, response) => {
    exchanges += 1;
    received.resolve();
    await release.promise;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ licenseKey: LICENSE_KEY }));
  });
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async () => {},
    randomBytes: deterministicRandom(23, 24, 25).randomBytes,
    siteOrigin: site.origin,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();
  const first = callbackParts(handle.activationUrl, token(26));
  const firstResponse = requestCallback(first.url);
  await received.promise;
  const second = callbackParts(handle.activationUrl, token(27));
  const secondResponse = await requestCallback(second.url);
  assert.equal(secondResponse.status, 400);
  assert.equal(exchanges, 1);

  release.resolve();
  assert.equal((await firstResponse).status, 200);
  assert.equal(await handle.result, LICENSE_KEY);
  assert.equal(exchanges, 1);
});

test("exchange redirects are never followed and a later exact callback may retry", async (t) => {
  let attackerHits = 0;
  const attacker = await testServer(t, async (_request, response) => {
    attackerHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ licenseKey: LICENSE_KEY }));
  });
  let redirect = true;
  const site = await testServer(t, async (_request, response) => {
    if (redirect) {
      response.writeHead(307, { location: `${attacker.origin}/stolen` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ licenseKey: LICENSE_KEY }));
  });
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async () => {},
    randomBytes: deterministicRandom(28, 29, 30).randomBytes,
    siteOrigin: site.origin,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();

  const refused = await requestCallback(callbackParts(handle.activationUrl, token(31)).url);
  assert.equal(refused.status, 502);
  assert.equal(attackerHits, 0);
  assert.ok(await remainsPending(handle.result));

  redirect = false;
  const accepted = await requestCallback(callbackParts(handle.activationUrl, token(32)).url);
  assert.equal(accepted.status, 200);
  assert.equal(await handle.result, LICENSE_KEY);
  assert.equal(attackerHits, 0);
});

test("malformed, extra-field, wrong-type, wrong-status, and oversized exchange bodies fail bounded", async (t) => {
  const origin = "http://127.0.0.1:49160";
  const exchangeUrl = `${origin}${PRO_EXCHANGE_PATH}`;
  const oversized = "x".repeat(PRO_EXCHANGE_MAX_RESPONSE_BYTES + 1);
  const responses = [
    responseFacade(exchangeUrl, "not json"),
    responseFacade(exchangeUrl, JSON.stringify({ licenseKey: LICENSE_KEY, extra: true })),
    responseFacade(exchangeUrl, JSON.stringify({ licenseKey: LICENSE_KEY }), { contentType: "text/plain" }),
    responseFacade(exchangeUrl, JSON.stringify({ error: "desktop activation failed" }), { status: 403 }),
    responseFacade(exchangeUrl, oversized),
    responseFacade(exchangeUrl, JSON.stringify({ licenseKey: LICENSE_KEY })),
  ];
  let fetches = 0;
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async () => {},
    fetch: async () => responses[fetches++],
    randomBytes: deterministicRandom(33, 34, 35).randomBytes,
    siteOrigin: origin,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();

  for (let index = 0; index < responses.length - 1; index += 1) {
    const response = await requestCallback(callbackParts(handle.activationUrl, token(40 + index)).url);
    assert.equal(response.status, 502, `response case ${index}`);
    assert.ok(response.body.length < PRO_EXCHANGE_MAX_RESPONSE_BYTES);
    assert.doesNotMatch(response.body, new RegExp(`${LICENSE_KEY}|${token(40 + index)}`));
    assert.ok(await remainsPending(handle.result));
  }
  const success = await requestCallback(callbackParts(handle.activationUrl, token(49)).url);
  assert.equal(success.status, 200);
  assert.equal(await handle.result, LICENSE_KEY);
  assert.equal(fetches, responses.length);
});

test("an oversized declared response is canceled before its body can be opened", async (t) => {
  const origin = "http://127.0.0.1:49161";
  const exchangeUrl = `${origin}${PRO_EXCHANGE_PATH}`;
  let canceled = 0;
  let opened = 0;
  let fetches = 0;
  const oversized = {
    body: {
      async cancel() {
        canceled += 1;
      },
      getReader() {
        opened += 1;
        throw new Error("oversized response body must not be opened");
      },
    },
    headers: new Headers({
      "content-length": String(PRO_EXCHANGE_MAX_RESPONSE_BYTES + 1),
      "content-type": "application/json",
    }),
    redirected: false,
    status: 200,
    url: exchangeUrl,
  };
  const success = responseFacade(exchangeUrl, JSON.stringify({ licenseKey: LICENSE_KEY }));
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async () => {},
    fetch: async () => (fetches++ === 0 ? oversized : success),
    randomBytes: deterministicRandom(50, 51, 52).randomBytes,
    siteOrigin: origin,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();

  assert.equal((await requestCallback(callbackParts(handle.activationUrl, token(53)).url)).status, 502);
  assert.equal(canceled, 1);
  assert.equal(opened, 0);
  assert.ok(await remainsPending(handle.result));
  assert.equal((await requestCallback(callbackParts(handle.activationUrl, token(54)).url)).status, 200);
  assert.equal(await handle.result, LICENSE_KEY);
});

test("a non-cooperating exchange is aborted at its fixed deadline and remains retryable", async (t) => {
  const origin = "http://127.0.0.1:49162";
  const exchangeUrl = `${origin}${PRO_EXCHANGE_PATH}`;
  let firstSignal;
  let fetches = 0;
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async () => {},
    exchangeDeadlineMs: 30,
    fetch: (_url, options) => {
      fetches += 1;
      if (fetches === 1) {
        firstSignal = options.signal;
        return new Promise(() => {});
      }
      return responseFacade(exchangeUrl, JSON.stringify({ licenseKey: LICENSE_KEY }));
    },
    randomBytes: deterministicRandom(55, 56, 57).randomBytes,
    siteOrigin: origin,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();

  assert.equal((await requestCallback(callbackParts(handle.activationUrl, token(58)).url)).status, 502);
  assert.equal(firstSignal.aborted, true);
  assert.ok(await remainsPending(handle.result));
  assert.equal((await requestCallback(callbackParts(handle.activationUrl, token(59)).url)).status, 200);
  assert.equal(await handle.result, LICENSE_KEY);
});

test("the fixed exchange deadline covers a stalled response body and remains retryable", async (t) => {
  const origin = "http://127.0.0.1:49164";
  const exchangeUrl = `${origin}${PRO_EXCHANGE_PATH}`;
  let bodyAborted = false;
  let firstSignal;
  let fetches = 0;
  const success = responseFacade(exchangeUrl, JSON.stringify({ licenseKey: LICENSE_KEY }));
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async () => {},
    exchangeDeadlineMs: 30,
    fetch: async (_url, options) => {
      fetches += 1;
      if (fetches !== 1) return success;
      firstSignal = options.signal;
      return {
        body: {
          getReader() {
            return {
              cancel: async () => {},
              read: () => new Promise((resolve, reject) => {
                if (firstSignal.aborted) {
                  bodyAborted = true;
                  reject(new Error("aborted"));
                  return;
                }
                firstSignal.addEventListener("abort", () => {
                  bodyAborted = true;
                  reject(new Error("aborted"));
                }, { once: true });
              }),
              releaseLock() {},
            };
          },
        },
        headers: new Headers({ "content-type": "application/json" }),
        redirected: false,
        status: 200,
        url: exchangeUrl,
      };
    },
    randomBytes: deterministicRandom(85, 86, 87).randomBytes,
    siteOrigin: origin,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();

  assert.equal((await requestCallback(callbackParts(handle.activationUrl, token(88)).url)).status, 502);
  assert.equal(firstSignal.aborted, true);
  assert.equal(bodyAborted, true);
  assert.ok(await remainsPending(handle.result));
  assert.equal((await requestCallback(callbackParts(handle.activationUrl, token(89)).url)).status, 200);
  assert.equal(await handle.result, LICENSE_KEY);
});

test("shutdown prevents a preflight in progress from creating a later listener", async () => {
  const loadStarted = deferred();
  const releaseLoad = deferred();
  let opened = 0;
  let saved = 0;
  let servers = 0;
  const controller = createProActivationController({
    store: {
      async load() {
        loadStarted.resolve();
        return releaseLoad.promise;
      },
      async remove() {},
      async save() {
        saved += 1;
      },
    },
    openBrowser: async () => {
      opened += 1;
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    createServer() {
      servers += 1;
      throw new Error("listener was not expected");
    },
  });

  const starting = controller.start();
  starting.catch(() => {});
  await loadStarted.promise;
  const shuttingDown = controller.shutdown();
  assert.ok(await remainsPending(shuttingDown));
  releaseLoad.resolve(null);
  assert.equal(await shuttingDown, false);
  await assert.rejects(starting, activationError("shutdown"));
  await assert.rejects(controller.resume(), activationError("shutdown"));
  assert.equal(servers, 0);
  assert.equal(saved, 0);
  assert.equal(opened, 0);
});

test("shutdown waits for an in-progress pending-state write after closing its listener", async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  let attempted;
  let opened = 0;
  let record = null;
  const controller = createProActivationController({
    store: {
      async load() {
        return clone(record);
      },
      async remove() {
        record = null;
      },
      async save(value) {
        attempted = clone(value);
        saveStarted.resolve();
        await releaseSave.promise;
        record = clone(value);
      },
    },
    openBrowser: async () => {
      opened += 1;
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(104, 105, 106).randomBytes,
  });

  const starting = controller.start();
  starting.catch(() => {});
  await saveStarted.promise;
  const shuttingDown = controller.shutdown();
  assert.ok(await remainsPending(shuttingDown));
  await assert.rejects(
    requestCallback(`http://127.0.0.1:${attempted.pending.callbackPort}/`),
    (error) => error.code === "ECONNREFUSED" || error.code === "ECONNRESET",
  );
  releaseSave.resolve();
  assert.equal(await shuttingDown, true);
  await assert.rejects(starting, activationError("shutdown"));
  assert.deepEqual(record, attempted);
  assert.equal(opened, 0);
});

test("deadline and shutdown close listeners even while the browser opener is pending", async (t) => {
  const timeoutEntered = deferred();
  const timeoutRelease = deferred();
  const timeoutStore = memoryStore();
  const timeoutController = createProActivationController({
    callbackDeadlineMs: 40,
    store: timeoutStore,
    openBrowser: async (url) => {
      timeoutEntered.resolve(url);
      await timeoutRelease.promise;
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(91, 92, 93).randomBytes,
  });
  t.after(async () => {
    timeoutRelease.resolve();
    await timeoutController.shutdown();
  });
  const timingOut = timeoutController.start();
  timingOut.catch(() => {});
  const timeoutUrl = await timeoutEntered.promise;
  await assert.rejects(timeoutController.resume(), activationError("busy"));
  await waitForListenerClose(timeoutUrl);
  await assert.rejects(timingOut, activationError("timeout"));
  timeoutRelease.resolve();
  assert.ok(timeoutStore.snapshot().pending);

  const shutdownEntered = deferred();
  const shutdownRelease = deferred();
  const shutdownStore = memoryStore();
  const shutdownController = createProActivationController({
    store: shutdownStore,
    openBrowser: async (url) => {
      shutdownEntered.resolve(url);
      await shutdownRelease.promise;
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(94, 95, 96).randomBytes,
  });
  t.after(async () => {
    shutdownRelease.resolve();
    await shutdownController.shutdown();
  });
  const stopping = shutdownController.start();
  stopping.catch(() => {});
  const shutdownUrl = await shutdownEntered.promise;
  assert.equal(await shutdownController.shutdown(), true);
  await waitForListenerClose(shutdownUrl);
  await assert.rejects(stopping, activationError("shutdown"));
  shutdownRelease.resolve();
  await assert.rejects(shutdownController.start(), activationError("shutdown"));
  assert.ok(shutdownStore.snapshot().pending);
});

test("a callback can complete while the browser opener remains pending", async (t) => {
  const site = await testServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ licenseKey: LICENSE_KEY }));
  });
  const openEntered = deferred();
  const openRelease = deferred();
  const controller = createProActivationController({
    store: memoryStore(),
    openBrowser: async (url) => {
      openEntered.resolve(url);
      await openRelease.promise;
    },
    randomBytes: deterministicRandom(97, 98, 99).randomBytes,
    siteOrigin: site.origin,
  });
  t.after(async () => {
    openRelease.resolve();
    await controller.shutdown();
  });

  const starting = controller.start();
  const activationUrl = await openEntered.promise;
  const callback = await requestCallback(callbackParts(activationUrl, token(100)).url);
  assert.equal(callback.status, 200);
  const handle = await starting;
  assert.equal(handle.activationUrl, activationUrl);
  assert.equal(await handle.result, LICENSE_KEY);
  openRelease.resolve();
});

test("callback timeout and shutdown close the listener while preserving the pending flow", async (t) => {
  const timeoutStore = memoryStore();
  const timeoutController = createProActivationController({
    callbackDeadlineMs: 40,
    store: timeoutStore,
    openBrowser: async () => {},
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(60, 61, 62).randomBytes,
  });
  t.after(() => timeoutController.shutdown());
  const timed = await timeoutController.start();
  await assert.rejects(timed.result, activationError("timeout"));
  assert.ok(timeoutStore.snapshot().pending);
  await assert.rejects(
    requestCallback(callbackParts(timed.activationUrl).url),
    (error) => error.code === "ECONNREFUSED" || error.code === "ECONNRESET",
  );

  const shutdownStore = memoryStore();
  const shutdownController = createProActivationController({
    store: shutdownStore,
    openBrowser: async () => {},
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(63, 64, 65).randomBytes,
  });
  t.after(() => shutdownController.shutdown());
  const stopped = await shutdownController.start();
  assert.equal(await shutdownController.shutdown(), true);
  await assert.rejects(stopped.result, activationError("shutdown"));
  assert.ok(shutdownStore.snapshot().pending);
  assert.equal(await shutdownController.shutdown(), false);
});

test("exact-boundary expiry removes only pending state and never opens a listener", async () => {
  const generated = createActivationRequest({
    callbackPort: 49163,
    now: () => 0,
    randomBytes: deterministicRandom(66, 67, 68).randomBytes,
  });
  for (const withKey of [false, true]) {
    const initial = { version: PRO_STORE_VERSION, pending: generated.pending };
    if (withKey) initial.licenseKey = RENEWAL_KEY;
    const store = memoryStore(initial);
    let servers = 0;
    const controller = createProActivationController({
      store,
      openBrowser: async () => {
        throw new Error("expired flow must not open a browser");
      },
      fetch: async () => {
        throw new Error("expired flow must not exchange");
      },
      createServer() {
        servers += 1;
        throw new Error("expired flow must not bind");
      },
      now: () => MAX_PENDING_LIFETIME_MS,
    });
    assert.equal(await controller.resume(), null);
    assert.equal(servers, 0);
    assert.deepEqual(
      store.snapshot(),
      withKey ? { version: PRO_STORE_VERSION, licenseKey: RENEWAL_KEY } : null,
    );
  }
});

test("expiry during restart binding clears the exact flow or reports cleanup failure", async () => {
  const reservation = http.createServer();
  const callbackPort = await listen(reservation);
  await closeServer(reservation);
  const generated = createActivationRequest({
    callbackPort,
    now: () => 0,
    randomBytes: deterministicRandom(101, 102, 103).randomBytes,
  });
  const store = memoryStore({
    version: PRO_STORE_VERSION,
    licenseKey: RENEWAL_KEY,
    pending: generated.pending,
  });
  let clockReads = 0;
  const controller = createProActivationController({
    store,
    openBrowser: async () => {
      throw new Error("expired flow must not open a browser");
    },
    fetch: async () => {
      throw new Error("expired flow must not exchange");
    },
    now: () => (clockReads++ === 0 ? MAX_PENDING_LIFETIME_MS - 1 : MAX_PENDING_LIFETIME_MS),
  });

  await assert.rejects(controller.resume(), activationError("expired"));
  assert.deepEqual(store.snapshot(), { version: PRO_STORE_VERSION, licenseKey: RENEWAL_KEY });

  const initial = {
    version: PRO_STORE_VERSION,
    licenseKey: RENEWAL_KEY,
    pending: generated.pending,
  };
  const failingStore = memoryStore(initial, {
    async save() {
      throw new Error("injected cleanup failure");
    },
  });
  clockReads = 0;
  const failingController = createProActivationController({
    store: failingStore,
    openBrowser: async () => {
      throw new Error("expired flow must not open a browser");
    },
    fetch: async () => {
      throw new Error("expired flow must not exchange");
    },
    now: () => (clockReads++ === 0 ? MAX_PENDING_LIFETIME_MS - 1 : MAX_PENDING_LIFETIME_MS),
  });
  await assert.rejects(failingController.resume(), activationError("store"));
  assert.deepEqual(failingStore.snapshot(), initial);
});

test("restart resumes the exact stored port and flow without reopening the browser", async (t) => {
  const site = await testServer(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ licenseKey: LICENSE_KEY }));
  });
  const store = memoryStore();
  const first = createProActivationController({
    store,
    openBrowser: async () => {},
    randomBytes: deterministicRandom(69, 70, 71).randomBytes,
    siteOrigin: site.origin,
  });
  const original = await first.start();
  assert.equal(await first.shutdown(), true);
  await assert.rejects(original.result, activationError("shutdown"));

  let reopened = 0;
  const resumedController = createProActivationController({
    store,
    openBrowser: async () => {
      reopened += 1;
    },
    siteOrigin: site.origin,
  });
  t.after(() => resumedController.shutdown());
  const resumed = await resumedController.resume();
  assert.ok(resumed);
  assert.equal(resumed.activationUrl, original.activationUrl);
  assert.equal(reopened, 0);
  const response = await requestCallback(callbackParts(resumed.activationUrl, token(72)).url);
  assert.equal(response.status, 200);
  assert.equal(await resumed.result, LICENSE_KEY);
});

test("restart refuses an occupied saved port without changing or exposing the pending flow", async (t) => {
  const blocker = http.createServer((_request, response) => response.end());
  const blockerPort = await listen(blocker);
  t.after(() => closeServer(blocker));
  const generated = createActivationRequest({
    callbackPort: blockerPort,
    now: () => 100,
    randomBytes: deterministicRandom(73, 74, 75).randomBytes,
  });
  const initial = { version: PRO_STORE_VERSION, pending: generated.pending };
  const store = memoryStore(initial);
  let opened = 0;
  let fetched = 0;
  const controller = createProActivationController({
    store,
    openBrowser: async () => {
      opened += 1;
    },
    fetch: async () => {
      fetched += 1;
    },
    now: () => 101,
  });

  await assert.rejects(controller.resume(), activationError("port-unavailable"));
  assert.deepEqual(store.snapshot(), initial);
  assert.equal(opened, 0);
  assert.equal(fetched, 0);
});

test("duplicate starts and resumes cannot replace one active or stored flow", async (t) => {
  const store = memoryStore();
  let opened = 0;
  const controller = createProActivationController({
    store,
    openBrowser: async () => {
      opened += 1;
    },
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(76, 77, 78).randomBytes,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();
  const saved = store.snapshot();
  await assert.rejects(controller.start(), activationError("busy"));
  await assert.rejects(controller.resume(), activationError("busy"));
  assert.equal(opened, 1);
  assert.deepEqual(store.snapshot(), saved);
  await controller.shutdown();
  await assert.rejects(handle.result, activationError("shutdown"));

  const second = createProActivationController({
    store,
    openBrowser: async () => {
      opened += 1;
    },
    fetch: async () => {},
  });
  await assert.rejects(second.start(), activationError("pending"));
  assert.equal(opened, 1);
  assert.deepEqual(store.snapshot(), saved);
});

test("the DPC.1 encrypted store accepts the generated pending record without plaintext persistence", {
  skip: process.platform === "win32",
}, async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "mirafold-pro-activation-"));
  await fs.chmod(userDataPath, 0o700);
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const safeStorage = {
    async decryptStringAsync(ciphertext) {
      const plaintext = Buffer.from(ciphertext.subarray(3));
      for (let index = 0; index < plaintext.length; index += 1) plaintext[index] ^= 0xa5;
      const result = plaintext.toString("utf8");
      plaintext.fill(0);
      return { result, shouldReEncrypt: false };
    },
    async encryptStringAsync(value) {
      const encrypted = Buffer.from(value, "utf8");
      for (let index = 0; index < encrypted.length; index += 1) encrypted[index] ^= 0xa5;
      return Buffer.concat([Buffer.from("v11"), encrypted]);
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    isAsyncEncryptionAvailable: async () => true,
  };
  const store = createProStore({ platform: "linux", safeStorage, userDataPath });
  const controller = createProActivationController({
    store,
    openBrowser: async () => {},
    fetch: async () => {
      throw new Error("exchange was not expected");
    },
    randomBytes: deterministicRandom(79, 80, 81).randomBytes,
  });
  t.after(() => controller.shutdown());
  const handle = await controller.start();
  const loaded = await store.load();
  assert.equal(loaded.pending.verifier, token(79));
  assert.equal(handle.activationUrl, activationUrlForPending(loaded.pending));
  const ciphertext = await fs.readFile(store.path);
  assert.doesNotMatch(ciphertext.toString("utf8"), new RegExp(`${loaded.pending.verifier}|${loaded.pending.state}`));
  await controller.shutdown();
  await assert.rejects(handle.result, activationError("shutdown"));
});
