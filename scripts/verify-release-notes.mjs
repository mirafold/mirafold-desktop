#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INCLUDED_VERSIONS = "## Included versions";
const INCLUDED_VERSIONS_RE = /^ {0,3}##[\t ]+Included versions(?:[\t ]+#+)?[\t ]*$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyReleaseNotes(notes, desktopVersion, shellVersion) {
  const text = String(notes).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const versions = [["Desktop", desktopVersion], ["Shell", shellVersion]];
  for (const [product, version] of versions) {
    invariant(typeof version === "string" && version.length > 0, `Mirafold ${product} version is missing`);
  }

  const expectedRows = versions.map(([product, version]) => `- Mirafold ${product} \`${version}\``);
  const expectedStart = [INCLUDED_VERSIONS, "", ...expectedRows, ""].join("\n");
  invariant(
    text.startsWith(expectedStart),
    `release notes must begin with the exact ${INCLUDED_VERSIONS} block`,
  );

  const headings = lines.flatMap((line, index) => INCLUDED_VERSIONS_RE.test(line) ? [index] : []);
  invariant(headings.length === 1, `release notes must contain exactly one ${INCLUDED_VERSIONS} heading`);

  for (const [product] of versions) {
    const declaration = new RegExp(`Mirafold ${product}[\\t ]+` + "`");
    const rows = lines.filter((line) => declaration.test(line));
    invariant(rows.length === 1, `release notes must contain exactly one Mirafold ${product} row`);
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
