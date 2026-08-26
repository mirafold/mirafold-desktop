// Helpers shared by the repository-owned release and verification scripts.
//
// Everything here is Node standard library only, deliberately: these scripts
// run in read-only CI jobs beside installed dependency code and must never
// pull that code into their own trust boundary. `release-contract.mjs` — the
// one verifier that also runs beside the repository-write token — stays fully
// self-contained and does not import even this file, so its dependency scan
// remains trivially auditable.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";

export const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Throw `message` unless `condition` holds. */
export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/** Return `value` if it is a stable X.Y.Z version string. */
export function stableVersion(value, label) {
  invariant(typeof value === "string" && STABLE_VERSION.test(value), `${label} must be a stable x.y.z version`);
  return value;
}

/** Require `value` to be a plain object whose keys are exactly `expected`. */
export function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} keys differ; expected [${wanted.join(", ")}], found [${actual.join(", ")}]`,
  );
}

/** Pretty JSON with a trailing newline, the on-disk form every script writes. */
export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Read a regular file that must contain one JSON object. */
export function readJson(file, label) {
  invariant(existsSync(file) && lstatSync(file).isFile(), `${label} must be a regular file`);
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must contain an object`);
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

/** Decode canonical (round-tripping, non-empty) base64. */
export function canonicalBase64(value, label) {
  invariant(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value), `${label} is not base64`);
  const bytes = Buffer.from(value, "base64");
  invariant(bytes.length > 0 && bytes.toString("base64") === value, `${label} is not canonical base64`);
  return bytes;
}

/** Return `value` if it is a canonical npm `sha512-<base64>` integrity string. */
export function canonicalIntegrity(value, label) {
  invariant(typeof value === "string" && value.startsWith("sha512-"), `${label} is not SHA-512 integrity`);
  const bytes = canonicalBase64(value.slice("sha512-".length), label);
  invariant(bytes.length === 64, `${label} is not a 64-byte SHA-512`);
  return value;
}

/**
 * Append `key=value` lines to a GitHub Actions output file. A missing file
 * argument means "not running under Actions" and is a no-op; a present one is
 * validated so a stray newline can never smuggle in a second output.
 */
export function appendGithubOutputs(file, entries) {
  if (file === undefined || file === null) return;
  invariant(typeof file === "string" && file.length > 0, "GitHub output path is invalid");
  invariant(lstatSync(file).isFile(), "GitHub output path must be a regular file");
  const lines = Object.entries(entries).map(([key, value]) => {
    invariant(/^[a-z][a-z0-9-]*$/.test(key), `invalid GitHub output name ${key}`);
    invariant(typeof value === "string" && !value.includes("\n") && !value.includes("\r"), `invalid GitHub output ${key}`);
    return `${key}=${value}`;
  });
  appendFileSync(file, `${lines.join("\n")}\n`);
}
