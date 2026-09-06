import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProStore,
  MAX_PENDING_LIFETIME_MS,
  MAX_PRO_CIPHERTEXT_BYTES,
  PRO_STORE_DIRECTORY,
  PRO_STORE_FILENAME,
  PRO_STORE_VERSION,
  ProStoreError,
} from "../src/pro-store.js";

const FILE_TEST_SKIP = process.platform !== "linux" && "Linux filesystem contract";
const NOW = 2_000_000_000_000;
const LICENSE_KEY = `mf_${"a".repeat(26)}`;
const RENEWAL_KEY = `mf_${"b".repeat(26)}`;

function token(byte) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function pending(overrides = {}) {
  const verifier = overrides.verifier ?? token(4);
  return {
    version: PRO_STORE_VERSION,
    callbackPort: 43125,
    callbackNonce: token(1),
    state: token(2),
    codeChallenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
    verifier,
    createdAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

function encoded(plaintext, serial, tag = "v11") {
  const body = Buffer.from(plaintext, "utf8");
  for (let index = 0; index < body.length; index += 1) body[index] ^= 0xa5;
  const header = Buffer.alloc(7);
  header.write(tag, 0, "ascii");
  header.writeUInt32BE(serial, 3);
  return Buffer.concat([header, body]);
}

function decoded(ciphertext) {
  if (
    !Buffer.isBuffer(ciphertext)
    || ciphertext.length < 7
    || !/^v\d\d$/.test(ciphertext.subarray(0, 3).toString("ascii"))
  ) {
    throw new Error("test ciphertext refused");
  }
  const body = Buffer.from(ciphertext.subarray(7));
  for (let index = 0; index < body.length; index += 1) body[index] ^= 0xa5;
  return body.toString("utf8");
}

function safeStorageAdapter(options = {}) {
  const state = {
    available: options.available ?? true,
    backend: options.backend ?? "gnome_libsecret",
    backends: options.backends ?? null,
    availabilityError: options.availabilityError ?? null,
    backendError: options.backendError ?? null,
    encryptError: options.encryptError ?? null,
    encryptResult: options.encryptResult,
    ciphertextTag: options.ciphertextTag ?? "v11",
    ciphertextTags: options.ciphertextTags ?? null,
    decryptError: options.decryptError ?? null,
    badDecryptResult: options.badDecryptResult ?? null,
    wrongProbe: options.wrongProbe ?? false,
    rotateRecords: options.rotateRecords ?? false,
    alwaysRotate: options.alwaysRotate ?? false,
    availabilityCalls: 0,
    backendCalls: 0,
    encryptionCalls: 0,
    decryptionCalls: 0,
    plainTextFallbackCalls: 0,
    rotated: new Set(),
  };

  const adapter = {
    async isAsyncEncryptionAvailable() {
      state.availabilityCalls += 1;
      if (state.availabilityError) throw state.availabilityError;
      return state.available;
    },
    getSelectedStorageBackend() {
      state.backendCalls += 1;
      if (state.backendError) throw state.backendError;
      if (state.backends) {
        return state.backends[Math.min(state.backendCalls - 1, state.backends.length - 1)];
      }
      return state.backend;
    },
    async encryptStringAsync(plaintext) {
      state.encryptionCalls += 1;
      if (state.encryptError) throw state.encryptError;
      if (state.encryptResult !== undefined) return state.encryptResult;
      const tag = state.ciphertextTags
        ? state.ciphertextTags[Math.min(
          state.encryptionCalls - 1,
          state.ciphertextTags.length - 1,
        )]
        : state.ciphertextTag;
      return encoded(plaintext, state.encryptionCalls, tag);
    },
    async decryptStringAsync(ciphertext) {
      state.decryptionCalls += 1;
      if (state.decryptError) throw state.decryptError;
      if (state.badDecryptResult !== null) return state.badDecryptResult;
      let plaintext = decoded(ciphertext);
      if (state.wrongProbe && plaintext === "mirafold-pro-safe-storage-v1") {
        plaintext = "wrong safeStorage probe";
      }
      const identity = ciphertext.toString("hex");
      const record = plaintext.startsWith("{");
      const firstRotation = record && state.rotateRecords && !state.rotated.has(identity);
      if (firstRotation) state.rotated.add(identity);
      return {
        shouldReEncrypt: state.alwaysRotate || firstRotation,
        result: plaintext,
      };
    },
    setUsePlainTextEncryption() {
      state.plainTextFallbackCalls += 1;
      throw new Error("plaintext fallback must never be called");
    },
  };
  return { adapter, state };
}

async function userData(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "mirafold-pro-store-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function storeFor(directory, safeStorage, options = {}) {
  return createProStore({
    safeStorage,
    userDataPath: directory,
    platform: "linux",
    now: options.now ?? (() => NOW),
    randomBytes: options.randomBytes ?? (() => Buffer.alloc(16, 9)),
    fs: options.fs ?? fs,
    fsConstants: options.fsConstants ?? fsConstants,
    ownerUid: options.ownerUid ?? process.getuid?.() ?? null,
  });
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof ProStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

test("preflight accepts every pinned Linux secret-service backend", async () => {
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    const { adapter, state } = safeStorageAdapter({ backend });
    const store = storeFor(path.resolve(tmpdir()), adapter);
    assert.deepEqual(await store.preflight(), { backend });
    assert.equal(state.plainTextFallbackCalls, 0);
  }

  const portal = safeStorageAdapter({ ciphertextTag: "v12" });
  assert.deepEqual(
    await storeFor(path.resolve(tmpdir()), portal.adapter).preflight(),
    { backend: "gnome_libsecret" },
  );
});

test("preflight refuses Electron's hard-coded v10 Posix fallback even behind a trusted backend name", async () => {
  const { adapter, state } = safeStorageAdapter({
    backend: "gnome_libsecret",
    ciphertextTag: "v10",
  });
  await rejectsCode(() => storeFor(path.resolve(tmpdir()), adapter).preflight(), "unavailable");
  assert.equal(state.decryptionCalls, 0, "the public-key fallback ciphertext was decrypted");
  assert.equal(state.plainTextFallbackCalls, 0);
});

test("preflight refuses every non-secret backend and a non-Linux caller", async () => {
  for (const backend of ["basic_text", "unknown", "future_unverified_provider"]) {
    const { adapter, state } = safeStorageAdapter({ backend });
    await rejectsCode(() => storeFor(path.resolve(tmpdir()), adapter).preflight(), "unavailable");
    assert.equal(state.encryptionCalls, 0, backend);
    assert.equal(state.plainTextFallbackCalls, 0, backend);
  }

  const { adapter } = safeStorageAdapter();
  const store = createProStore({
    safeStorage: adapter,
    userDataPath: path.resolve(tmpdir()),
    platform: "win32",
  });
  await rejectsCode(() => store.preflight(), "unsupported-platform");
});

test("preflight maps each asynchronous availability and probe failure to one safe error", async () => {
  const cases = [
    { available: false },
    { availabilityError: new Error(`availability ${LICENSE_KEY}`) },
    { backendError: new Error(`backend ${LICENSE_KEY}`) },
    { encryptError: new Error(`encrypt ${LICENSE_KEY}`) },
    { encryptResult: "not a buffer" },
    { encryptResult: Buffer.alloc(0) },
    { encryptResult: Buffer.alloc(MAX_PRO_CIPHERTEXT_BYTES + 1) },
    { decryptError: new Error(`decrypt ${LICENSE_KEY}`) },
    { badDecryptResult: null, wrongProbe: true },
    { badDecryptResult: { shouldReEncrypt: "yes", result: "bad" } },
    { alwaysRotate: true },
    { backends: ["gnome_libsecret", "basic_text"] },
  ];

  for (const options of cases) {
    const configured = options.badDecryptResult === null
      ? { ...options, badDecryptResult: undefined }
      : options;
    const { adapter } = safeStorageAdapter(configured);
    await assert.rejects(
      () => storeFor(path.resolve(tmpdir()), adapter).preflight(),
      (error) => {
        assert.equal(error.code, "unavailable");
        assert.doesNotMatch(error.message, new RegExp(LICENSE_KEY));
        return true;
      },
    );
  }
});

test("key-only, pending-only, and renewal state round-trip as ciphertext", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  const records = [
    { version: PRO_STORE_VERSION, licenseKey: LICENSE_KEY },
    { version: PRO_STORE_VERSION, pending: pending() },
    { version: PRO_STORE_VERSION, licenseKey: RENEWAL_KEY, pending: pending() },
  ];

  for (const record of records) {
    assert.deepEqual(await store.save(record), record);
    assert.deepEqual(await store.load(), record);
    const ciphertext = await fs.readFile(store.path);
    assert.ok(!ciphertext.includes(Buffer.from(LICENSE_KEY)));
    assert.ok(!ciphertext.includes(Buffer.from(RENEWAL_KEY)));
    assert.ok(!ciphertext.includes(Buffer.from(record.pending?.verifier ?? "absent")));
  }

  assert.equal(store.path, path.join(directory, PRO_STORE_DIRECTORY, PRO_STORE_FILENAME));
  assert.equal((await fs.stat(path.dirname(store.path))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(store.path)).mode & 0o777, 0o600);
  await assert.rejects(() => fs.stat(path.join(directory, "state.json")), { code: "ENOENT" });
});

test("a backend or ciphertext-provider downgrade during record encryption stops before persistence", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter, state } = safeStorageAdapter({
    backends: ["gnome_libsecret", "gnome_libsecret", "basic_text"],
  });
  const store = storeFor(directory, adapter);
  await rejectsCode(() => store.save({ version: 1, licenseKey: LICENSE_KEY }), "unavailable");
  assert.deepEqual(await store.inspect(), { present: false });
  assert.equal(state.plainTextFallbackCalls, 0);

  const secondDirectory = await userData(t);
  const fallback = safeStorageAdapter({ ciphertextTags: ["v11", "v10"] });
  const fallbackStore = storeFor(secondDirectory, fallback.adapter);
  await rejectsCode(
    () => fallbackStore.save({ version: 1, licenseKey: LICENSE_KEY }),
    "unavailable",
  );
  assert.deepEqual(await fallbackStore.inspect(), { present: false });
});

test("the exact envelope and pending schemas reject every malformed field class", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  const validPending = pending();
  const invalidRecords = [
    null,
    {},
    { version: 2, licenseKey: LICENSE_KEY },
    { version: 1, licenseKey: LICENSE_KEY, extra: true },
    { version: 1, licenseKey: "not-a-license" },
    { version: 1, pending: { ...validPending, extra: true } },
    { version: 1, pending: { ...validPending, version: 2 } },
    { version: 1, pending: { ...validPending, callbackPort: 1023 } },
    { version: 1, pending: { ...validPending, callbackPort: 65536 } },
    { version: 1, pending: { ...validPending, callbackNonce: token(1).slice(1) } },
    { version: 1, pending: { ...validPending, state: `${token(2)}=` } },
    { version: 1, pending: { ...validPending, verifier: token(8) } },
    { version: 1, pending: { ...validPending, createdAtMs: -1 } },
    { version: 1, pending: { ...validPending, expiresAtMs: validPending.createdAtMs } },
    { version: 1, pending: { ...validPending, expiresAtMs: NOW } },
    {
      version: 1,
      pending: {
        ...validPending,
        createdAtMs: NOW,
        expiresAtMs: NOW + MAX_PENDING_LIFETIME_MS + 1,
      },
    },
    { version: 1, pending: { ...validPending, createdAtMs: NOW + 1 } },
  ];

  for (const record of invalidRecords) {
    await rejectsCode(() => store.save(record), "invalid");
  }
  assert.deepEqual(await store.inspect(), { present: false });

  const ceiling = pending({
    createdAtMs: NOW,
    expiresAtMs: NOW + MAX_PENDING_LIFETIME_MS,
  });
  assert.deepEqual(
    await store.save({ version: 1, pending: ceiling }),
    { version: 1, pending: ceiling },
  );
});

test("load expires only pending state and preserves a current key", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const clock = { now: NOW };
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter, { now: () => clock.now });
  await store.save({ version: 1, licenseKey: LICENSE_KEY, pending: pending() });

  clock.now = NOW + 60_000;
  assert.deepEqual(await store.load(), { version: 1, licenseKey: LICENSE_KEY });
  assert.deepEqual(await store.load(), { version: 1, licenseKey: LICENSE_KEY });
  assert.deepEqual(await store.inspect(), { present: true });
});

test("load removes an expired pending-only record", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const clock = { now: NOW };
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter, { now: () => clock.now });
  await store.save({ version: 1, pending: pending() });

  clock.now = NOW + 60_001;
  assert.equal(await store.load(), null);
  assert.deepEqual(await store.inspect(), { present: false });
});

test("load follows safeStorage's rotation signal and atomically re-encrypts", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter, state } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  await store.save({ version: 1, licenseKey: LICENSE_KEY });
  const before = await fs.readFile(store.path);
  state.rotateRecords = true;

  assert.deepEqual(await store.load(), { version: 1, licenseKey: LICENSE_KEY });
  const after = await fs.readFile(store.path);
  assert.notDeepEqual(after, before);
  assert.ok(state.decryptionCalls >= 4, "rotation did not request the second decrypted result");
});

test("corrupt ciphertext and malformed decrypted state fail without disclosing supplied bytes", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  await store.save({ version: 1, licenseKey: LICENSE_KEY });

  await fs.writeFile(store.path, Buffer.from(`corrupt-${LICENSE_KEY}`));
  await assert.rejects(() => store.load(), (error) => {
    assert.equal(error.code, "corrupt");
    assert.doesNotMatch(error.message, new RegExp(LICENSE_KEY));
    return true;
  });

  const malformed = await adapter.encryptStringAsync(JSON.stringify({
    version: 1,
    licenseKey: LICENSE_KEY,
    unexpected: token(7),
  }));
  await fs.writeFile(store.path, malformed, { mode: 0o600 });
  await assert.rejects(() => store.load(), (error) => {
    assert.equal(error.code, "corrupt");
    assert.doesNotMatch(error.message, new RegExp(LICENSE_KEY));
    assert.doesNotMatch(error.message, new RegExp(token(7)));
    return true;
  });

  await fs.writeFile(
    store.path,
    encoded(JSON.stringify({ version: 1, licenseKey: LICENSE_KEY }), 99, "v10"),
    { mode: 0o600 },
  );
  await assert.rejects(() => store.load(), (error) => {
    assert.equal(error.code, "corrupt");
    assert.doesNotMatch(error.message, new RegExp(LICENSE_KEY));
    return true;
  });
});

test("symlinked, non-regular, wrong-mode, and oversized records fail closed", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  await store.save({ version: 1, licenseKey: LICENSE_KEY });
  const target = path.join(directory, "outside.bin");
  await fs.writeFile(target, "outside", { mode: 0o600 });

  await fs.unlink(store.path);
  await fs.symlink(target, store.path);
  for (const operation of [store.inspect, store.load, () => store.save({
    version: 1,
    licenseKey: RENEWAL_KEY,
  }), store.remove]) {
    await rejectsCode(operation, "unsafe");
  }
  assert.equal(await fs.readFile(target, "utf8"), "outside");

  await fs.unlink(store.path);
  await fs.mkdir(store.path, { mode: 0o600 });
  await fs.chmod(store.path, 0o600);
  await rejectsCode(() => store.load(), "unsafe");
  await fs.rm(store.path, { recursive: true });

  await store.save({ version: 1, licenseKey: LICENSE_KEY });
  await fs.chmod(store.path, 0o640);
  await rejectsCode(() => store.load(), "unsafe");
  await fs.chmod(store.path, 0o600);

  await fs.writeFile(store.path, Buffer.alloc(MAX_PRO_CIPHERTEXT_BYTES + 1));
  await rejectsCode(() => store.load(), "unsafe");
});

test("a symlinked or permissive store directory is refused", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const outside = await fs.mkdtemp(path.join(tmpdir(), "mirafold-pro-outside-test-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  await fs.symlink(outside, path.join(directory, PRO_STORE_DIRECTORY));
  await rejectsCode(() => store.inspect(), "unsafe");

  await fs.unlink(path.join(directory, PRO_STORE_DIRECTORY));
  await fs.mkdir(path.join(directory, PRO_STORE_DIRECTORY), { mode: 0o755 });
  await fs.chmod(path.join(directory, PRO_STORE_DIRECTORY), 0o755);
  await rejectsCode(() => store.inspect(), "unsafe");
});

test("interruption before rename preserves the prior record and removes the temporary file", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter } = safeStorageAdapter();
  const original = storeFor(directory, adapter);
  await original.save({ version: 1, licenseKey: LICENSE_KEY });
  const priorCiphertext = await fs.readFile(original.path);
  const interruptedFs = {
    ...fs,
    async rename() {
      const error = new Error("injected interruption");
      error.code = "EIO";
      throw error;
    },
  };
  const interrupted = storeFor(directory, adapter, { fs: interruptedFs });

  await rejectsCode(
    () => interrupted.save({ version: 1, licenseKey: RENEWAL_KEY }),
    "write",
  );
  assert.deepEqual(await fs.readFile(original.path), priorCiphertext);
  assert.deepEqual(await original.load(), { version: 1, licenseKey: LICENSE_KEY });
  assert.deepEqual(await fs.readdir(path.dirname(original.path)), [PRO_STORE_FILENAME]);
});

test("inspection supports confirmation and removal is secure, keyring-independent, and idempotent", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter, state } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  assert.deepEqual(await store.inspect(), { present: false });
  assert.equal(await store.remove(), false);

  await store.save({ version: 1, licenseKey: LICENSE_KEY });
  assert.deepEqual(await store.inspect(), { present: true });
  state.available = false;
  state.backend = "basic_text";
  assert.equal(await store.remove(), true);
  assert.equal(await store.remove(), false);
  assert.deepEqual(await store.inspect(), { present: false });
});

test("owner identity is checked independently from mode bits", { skip: FILE_TEST_SKIP }, async (t) => {
  const directory = await userData(t);
  const { adapter } = safeStorageAdapter();
  const store = storeFor(directory, adapter);
  await store.save({ version: 1, licenseKey: LICENSE_KEY });
  const wrongOwner = storeFor(directory, adapter, { ownerUid: process.getuid() + 1 });
  await rejectsCode(() => wrongOwner.inspect(), "unsafe");
});
