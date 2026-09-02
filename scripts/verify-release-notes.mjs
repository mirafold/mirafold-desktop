#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INCLUDED_VERSIONS = "## Included versions";
const INCLUDED_VERSIONS_RE = /^ {0,3}##[\t ]+Included versions(?:[\t ]+#+)?[\t ]*$/;
const SECOND_LEVEL_HEADING_RE = /^ {0,3}##(?:[\t ]+|$)/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyReleaseNotes(notes, desktopVersion, shellVersion) {
  const lines = String(notes).replace(/\r\n?/g, "\n").split("\n");
  const headings = lines.flatMap((line, index) => INCLUDED_VERSIONS_RE.test(line) ? [index] : []);
  invariant(headings.length === 1, `release notes must contain exactly one ${INCLUDED_VERSIONS} heading`);
  invariant(lines[headings[0]] === INCLUDED_VERSIONS, `release notes must use the exact heading: ${INCLUDED_VERSIONS}`);

  const start = headings[0] + 1;
  const nextHeading = lines.findIndex((line, index) => index >= start && SECOND_LEVEL_HEADING_RE.test(line));
  const section = lines.slice(start, nextHeading === -1 ? lines.length : nextHeading);

  for (const [product, version] of [["Desktop", desktopVersion], ["Shell", shellVersion]]) {
    invariant(typeof version === "string" && version.length > 0, `Mirafold ${product} version is missing`);
    const prefix = `- Mirafold ${product} `;
    const declaration = new RegExp(`Mirafold ${product}[\\t ]+` + "`");
    const rows = lines.filter((line) => declaration.test(line));
    const expected = `${prefix}\`${version}\``;
    invariant(rows.length === 1, `release notes must contain exactly one Mirafold ${product} row`);
    invariant(rows[0] === expected, `release notes must contain exactly: ${expected}`);
    invariant(section.includes(expected), `${expected} must be inside ${INCLUDED_VERSIONS}`);
  }
}

function main(args) {
  if (args.length !== 0) throw new Error("usage: verify-release-notes.mjs");
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  verifyReleaseNotes(
    readFileSync(path.join(ROOT, ".github", "RELEASE_NOTES.md"), "utf8"),
    packageJson.version,
    packageJson.dependencies?.mirafold,
  );
  process.stdout.write(
    `release notes match Desktop ${packageJson.version} and Shell ${packageJson.dependencies.mirafold}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release notes verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
