// Linux Pro state is security-sensitive and intentionally separate from the
// best-effort preferences in state.js. Electron main injects safeStorage only
// when activation needs it, so an unavailable secret service never prevents an
// ordinary Mirafold launch.

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants as nodeFsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import path from "node:path";

export const PRO_STORE_VERSION = 1;
export const PRO_STORE_DIRECTORY = "mirafold-pro";
export const PRO_STORE_FILENAME = "secret-state-v1.bin";
export const MAX_PENDING_LIFETIME_MS = 48 * 60 * 60 * 1000;
export const MAX_PRO_CIPHERTEXT_BYTES = 64 * 1024;

const MAX_PRO_PLAINTEXT_BYTES = 8 * 1024;
const PROBE_TEXT = "mirafold-pro-safe-storage-v1";
const ACCEPTED_LINUX_BACKENDS = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);
// Electron 43.4 tags async ciphertext with the provider that supplied its key.
// v10 is the public hard-coded Posix fallback; v11 is Secret Service/KWallet,
// and v12 is org.freedesktop.portal.Secret. Checking the configured backend is
// insufficient because its provider can fail while Electron silently uses v10.
const ACCEPTED_LINUX_CIPHERTEXT_TAGS = [Buffer.from("v11"), Buffer.from("v12")];
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
  "unsupported-platform": "Mirafold Pro secure storage is unavailable on this platform.",
  unavailable: "Mirafold Pro secure storage is temporarily unavailable.",
  unsafe: "Mirafold Pro secure storage cannot be used safely.",
  corrupt: "Mirafold Pro secure state could not be read safely.",
  invalid: "Mirafold Pro secret state is invalid.",
  write: "Mirafold Pro secure state could not be updated.",
});

export class ProStoreError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? "Mirafold Pro secure storage failed.");
    this.name = "ProStoreError";
    this.code = code;
  }
}

const fail = (code) => new ProStoreError(code);

function hasExactFields(value, allowedFields, requiredFields = allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowedFields.includes(key))
    && requiredFields.every((field) => keys.includes(field));
}

function isB64url256(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function isLicenseKey(value) {
  return typeof value === "string" && /^mf_[a-z2-7]{20,40}$/.test(value);
}

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function expectedChallenge(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function validatePending(value, nowMs, forWrite) {
  if (!hasExactFields(value, PENDING_FIELDS)) throw fail("invalid");
  if (
    value.version !== PRO_STORE_VERSION
    || !Number.isInteger(value.callbackPort)
    || value.callbackPort < 1024
    || value.callbackPort > 65535
    || !isB64url256(value.callbackNonce)
    || !isB64url256(value.state)
    || !isB64url256(value.codeChallenge)
    || !isB64url256(value.verifier)
    || value.codeChallenge !== expectedChallenge(value.verifier)
    || !isSafeTimestamp(value.createdAtMs)
    || !isSafeTimestamp(value.expiresAtMs)
    || value.expiresAtMs <= value.createdAtMs
    || value.expiresAtMs - value.createdAtMs > MAX_PENDING_LIFETIME_MS
    || (forWrite && (
      value.createdAtMs > nowMs
      || value.expiresAtMs <= nowMs
      || value.expiresAtMs > nowMs + MAX_PENDING_LIFETIME_MS
    ))
  ) {
    throw fail("invalid");
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

function validateEnvelope(value, nowMs, forWrite) {
  if (!hasExactFields(value, ENVELOPE_FIELDS, ["version"])) throw fail("invalid");
  if (value.version !== PRO_STORE_VERSION) throw fail("invalid");

  const hasLicenseKey = Object.hasOwn(value, "licenseKey");
  const hasPending = Object.hasOwn(value, "pending");
  if (!hasLicenseKey && !hasPending) throw fail("invalid");
  if (hasLicenseKey && !isLicenseKey(value.licenseKey)) throw fail("invalid");
  const pending = hasPending ? validatePending(value.pending, nowMs, forWrite) : undefined;

  const envelope = { version: PRO_STORE_VERSION };
  if (hasLicenseKey) envelope.licenseKey = value.licenseKey;
  if (hasPending) envelope.pending = pending;
  return Object.freeze(envelope);
}

function validDecryptResult(value) {
  return value
    && typeof value === "object"
    && typeof value.shouldReEncrypt === "boolean"
    && typeof value.result === "string";
}

function hasAcceptedCiphertextTag(value) {
  return Buffer.isBuffer(value) && ACCEPTED_LINUX_CIPHERTEXT_TAGS.some(
    (tag) => value.subarray(0, tag.length).equals(tag),
  );
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

function isMissing(error) {
  return error?.code === "ENOENT";
}

function isSymlinkRefusal(error) {
  return error?.code === "ELOOP" || error?.code === "EMLINK";
}

/**
 * Build the Linux secret-state store without importing Electron. Keeping every
 * capability injected makes the fail-closed policy testable without touching a
 * developer's real keyring or userData directory.
 */
export function createProStore({
  safeStorage,
  userDataPath,
  fs = nodeFs,
  fsConstants = nodeFsConstants,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  platform = process.platform,
  ownerUid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (
    !safeStorage
    || typeof safeStorage.isAsyncEncryptionAvailable !== "function"
    || typeof safeStorage.getSelectedStorageBackend !== "function"
    || typeof safeStorage.encryptStringAsync !== "function"
    || typeof safeStorage.decryptStringAsync !== "function"
  ) {
    throw new TypeError("safeStorage adapter is required");
  }
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new TypeError("an absolute userData path is required");
  }
  if (typeof now !== "function" || typeof randomBytes !== "function") {
    throw new TypeError("clock and randomness adapters are required");
  }

  const directoryPath = path.join(userDataPath, PRO_STORE_DIRECTORY);
  const filePath = path.join(directoryPath, PRO_STORE_FILENAME);
  let operationTail = Promise.resolve();

  const serialize = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  };

  function openFlags(...names) {
    let flags = 0;
    for (const name of names) {
      const value = fsConstants[name];
      if (!Number.isInteger(value) || (value === 0 && name !== "O_RDONLY")) {
        throw fail("unsafe");
      }
      flags |= value;
    }
    return flags;
  }

  function assertOwnedMode(stats, expectedMode, kind) {
    const rightKind = kind === "directory" ? stats.isDirectory() : stats.isFile();
    if (
      !rightKind
      || ownerUid === null
      || stats.uid !== ownerUid
      || (stats.mode & 0o777) !== expectedMode
    ) {
      throw fail("unsafe");
    }
  }

  async function closeQuietly(handle) {
    try {
      await handle?.close();
    } catch {
      // The primary operation already failed; do not replace its safe error.
    }
  }

  async function openDirectory(create) {
    let created = false;
    if (create) {
      try {
        await fs.mkdir(directoryPath, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw fail("write");
      }
      if (created) {
        try {
          await fs.chmod(directoryPath, 0o700);
        } catch {
          throw fail("write");
        }
      }
    }

    let handle;
    try {
      handle = await fs.open(
        directoryPath,
        openFlags("O_RDONLY", "O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK"),
      );
      assertOwnedMode(await handle.stat(), 0o700, "directory");
      return handle;
    } catch (error) {
      await closeQuietly(handle);
      if (!create && isMissing(error)) return null;
      if (error instanceof ProStoreError) throw error;
      if (isSymlinkRefusal(error)) throw fail("unsafe");
      throw fail(create ? "write" : "unsafe");
    }
  }

  async function openRegularFile() {
    let handle;
    try {
      handle = await fs.open(
        filePath,
        openFlags("O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK"),
      );
      const stats = await handle.stat();
      assertOwnedMode(stats, 0o600, "file");
      if (stats.size <= 0 || stats.size > MAX_PRO_CIPHERTEXT_BYTES) throw fail("unsafe");
      return { handle, size: stats.size };
    } catch (error) {
      await closeQuietly(handle);
      if (isMissing(error)) return null;
      if (error instanceof ProStoreError) throw error;
      if (isSymlinkRefusal(error)) throw fail("unsafe");
      throw fail("unsafe");
    }
  }

  async function readCiphertext() {
    const directory = await openDirectory(false);
    if (!directory) return null;

    let opened;
    try {
      opened = await openRegularFile();
      if (!opened) return null;
      const buffer = Buffer.allocUnsafe(MAX_PRO_CIPHERTEXT_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await opened.handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== opened.size || offset > MAX_PRO_CIPHERTEXT_BYTES) throw fail("unsafe");
      return Buffer.from(buffer.subarray(0, offset));
    } catch (error) {
      if (error instanceof ProStoreError) throw error;
      throw fail("unsafe");
    } finally {
      await closeQuietly(opened?.handle);
      await closeQuietly(directory);
    }
  }

  async function assertTargetReplaceable() {
    const opened = await openRegularFile();
    if (!opened) return;
    await closeQuietly(opened.handle);
  }

  async function replaceCiphertext(ciphertext) {
    if (
      !Buffer.isBuffer(ciphertext)
      || ciphertext.length <= 0
      || ciphertext.length > MAX_PRO_CIPHERTEXT_BYTES
    ) {
      throw fail("write");
    }

    const directory = await openDirectory(true);
    let temporaryHandle;
    let temporaryPath;
    let renamed = false;
    try {
      await assertTargetReplaceable();
      const random = randomBytes(16);
      if (!Buffer.isBuffer(random) || random.length !== 16) throw fail("write");
      temporaryPath = path.join(
        directoryPath,
        `.${PRO_STORE_FILENAME}.${random.toString("hex")}.tmp`,
      );
      temporaryHandle = await fs.open(
        temporaryPath,
        openFlags("O_WRONLY", "O_CREAT", "O_EXCL", "O_NOFOLLOW"),
        0o600,
      );
      await temporaryHandle.chmod(0o600);
      assertOwnedMode(await temporaryHandle.stat(), 0o600, "file");

      let offset = 0;
      while (offset < ciphertext.length) {
        const { bytesWritten } = await temporaryHandle.write(
          ciphertext,
          offset,
          ciphertext.length - offset,
          offset,
        );
        if (bytesWritten <= 0) throw fail("write");
        offset += bytesWritten;
      }
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = null;

      // Recheck immediately before replacement. rename() replaces a symlink
      // rather than following it, but refusing one keeps the storage contract
      // explicit and turns unexpected filesystem state into a recoverable stop.
      await assertTargetReplaceable();
      await fs.rename(temporaryPath, filePath);
      renamed = true;
      await directory.sync();
    } catch (error) {
      await closeQuietly(temporaryHandle);
      if (!renamed && temporaryPath) {
        try {
          await fs.unlink(temporaryPath);
        } catch {
          // A failed cleanup never replaces the original safe failure.
        }
      }
      if (error instanceof ProStoreError) throw error;
      throw fail("write");
    } finally {
      await closeQuietly(directory);
    }
  }

  async function removeRaw() {
    const directory = await openDirectory(false);
    if (!directory) return false;
    let opened;
    try {
      opened = await openRegularFile();
      if (!opened) return false;
      await opened.handle.close();
      opened = null;
      await fs.unlink(filePath);
      await directory.sync();
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      if (error instanceof ProStoreError) throw error;
      throw fail("write");
    } finally {
      await closeQuietly(opened?.handle);
      await closeQuietly(directory);
    }
  }

  async function decrypt(ciphertext, errorCode) {
    let first;
    try {
      first = await safeStorage.decryptStringAsync(ciphertext);
      if (!validDecryptResult(first)) throw fail(errorCode);
      if (!first.shouldReEncrypt) {
        return { plaintext: first.result, shouldReEncrypt: false };
      }
      const second = await safeStorage.decryptStringAsync(ciphertext);
      if (!validDecryptResult(second) || second.shouldReEncrypt) throw fail(errorCode);
      return { plaintext: second.result, shouldReEncrypt: true };
    } catch (error) {
      if (error instanceof ProStoreError) throw error;
      throw fail(errorCode);
    }
  }

  function selectedBackend() {
    let backend;
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      throw fail("unavailable");
    }
    if (!ACCEPTED_LINUX_BACKENDS.has(backend)) throw fail("unavailable");
    return backend;
  }

  async function preflightRaw() {
    if (platform !== "linux") throw fail("unsupported-platform");
    let available;
    try {
      available = await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      throw fail("unavailable");
    }
    if (available !== true) throw fail("unavailable");
    const backend = selectedBackend();

    let encrypted;
    try {
      encrypted = await safeStorage.encryptStringAsync(PROBE_TEXT);
      if (
        !Buffer.isBuffer(encrypted)
        || encrypted.length === 0
        || encrypted.length > MAX_PRO_CIPHERTEXT_BYTES
        || !hasAcceptedCiphertextTag(encrypted)
      ) {
        throw fail("unavailable");
      }
      const probe = await decrypt(encrypted, "unavailable");
      if (probe.plaintext !== PROBE_TEXT) throw fail("unavailable");
      if (selectedBackend() !== backend) throw fail("unavailable");
      return Object.freeze({ backend });
    } catch (error) {
      if (error instanceof ProStoreError) throw error;
      throw fail("unavailable");
    } finally {
      if (Buffer.isBuffer(encrypted)) encrypted.fill(0);
    }
  }

  async function encryptAndReplace(envelope, backend) {
    const plaintext = JSON.stringify(envelope);
    if (Buffer.byteLength(plaintext, "utf8") > MAX_PRO_PLAINTEXT_BYTES) throw fail("invalid");
    let ciphertext;
    try {
      ciphertext = await safeStorage.encryptStringAsync(plaintext);
      if (!hasAcceptedCiphertextTag(ciphertext)) throw fail("unavailable");
      if (selectedBackend() !== backend) throw fail("unavailable");
      await replaceCiphertext(ciphertext);
    } catch (error) {
      if (error instanceof ProStoreError) throw error;
      throw fail("write");
    } finally {
      if (Buffer.isBuffer(ciphertext)) ciphertext.fill(0);
    }
  }

  async function saveRaw(value) {
    const { backend } = await preflightRaw();
    const envelope = validateEnvelope(value, safeNow(now), true);
    await encryptAndReplace(envelope, backend);
    return envelope;
  }

  async function loadRaw() {
    const { backend } = await preflightRaw();
    const ciphertext = await readCiphertext();
    if (!ciphertext) return null;
    if (!hasAcceptedCiphertextTag(ciphertext)) {
      ciphertext.fill(0);
      throw fail("corrupt");
    }

    let decrypted;
    try {
      if (selectedBackend() !== backend) throw fail("unavailable");
      decrypted = await decrypt(ciphertext, "corrupt");
      if (selectedBackend() !== backend) throw fail("unavailable");
    } finally {
      ciphertext.fill(0);
    }
    if (Buffer.byteLength(decrypted.plaintext, "utf8") > MAX_PRO_PLAINTEXT_BYTES) {
      throw fail("corrupt");
    }

    let parsed;
    try {
      parsed = JSON.parse(decrypted.plaintext);
    } catch {
      throw fail("corrupt");
    }

    let envelope;
    const nowMs = safeNow(now);
    try {
      envelope = validateEnvelope(parsed, nowMs, false);
    } catch {
      throw fail("corrupt");
    }

    const pendingExpired = envelope.pending?.expiresAtMs <= nowMs;
    if (pendingExpired) {
      if (envelope.licenseKey) {
        envelope = Object.freeze({
          version: PRO_STORE_VERSION,
          licenseKey: envelope.licenseKey,
        });
        await encryptAndReplace(envelope, backend);
      } else {
        await removeRaw();
        return null;
      }
    } else if (decrypted.shouldReEncrypt) {
      await encryptAndReplace(envelope, backend);
    }
    return envelope;
  }

  async function inspectRaw() {
    const directory = await openDirectory(false);
    if (!directory) return Object.freeze({ present: false });
    let opened;
    try {
      opened = await openRegularFile();
      return Object.freeze({ present: opened !== null });
    } finally {
      await closeQuietly(opened?.handle);
      await closeQuietly(directory);
    }
  }

  return Object.freeze({
    path: filePath,
    preflight: () => serialize(preflightRaw),
    load: () => serialize(loadRaw),
    save: (value) => serialize(() => saveRaw(value)),
    inspect: () => serialize(inspectRaw),
    remove: () => serialize(removeRaw),
  });
}
