// Packaging must preserve the platform-specific N-API binaries selected by
// npm. electron-builder's generic native rebuild does not understand
// @parcel/watcher's wrapper/optional-package layout and otherwise tries to
// compile the wrapper package from source before any artifact is produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const builderConfig = readFileSync(
  new URL("../electron-builder.yml", import.meta.url),
  "utf8",
)
  .split("\r\n")
  .join("\n");
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const mainSource = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("electron-builder preserves npm-selected N-API binaries", () => {
  assert.match(builderConfig, /(?:^|\n)npmRebuild:\s*false(?:\n|$)/);
});

test("the updater protocol implementation is an exact runtime dependency", () => {
  assert.equal(packageMetadata.dependencies?.["electron-updater"], "6.8.9");
  assert.equal(packageMetadata.devDependencies?.["electron-updater"], undefined);
});

test("packaged update metadata targets only Mirafold's public stable GitHub channel", () => {
  assert.match(
    builderConfig,
    /(?:^|\n)publish:\s*\n\s+- provider: github\s*\n\s+owner: mirafold\s*\n\s+repo: mirafold-desktop\s*\n\s+channel: latest\s*\n\s+private: false\s*\n\s+publishAutoUpdate: true(?:\n|$)/,
  );
  assert.match(builderConfig, /(?:^|\n)generateUpdatesFilesForAllChannels:\s*false(?:\n|$)/);
  assert.doesNotMatch(builderConfig, /(?:^|\n)\s*token:/, "a client update credential must never be packaged");
});

test("the packaged runtime wires Linux form detection to the updater policy", () => {
  for (const required of [
    "desktopUpdateStrategy({",
    "process.env.APPIMAGE",
    'path.join(process.resourcesPath, "package-type")',
    'updateStrategy === "manual-download"',
    "new AppUpdater()",
  ]) {
    assert.ok(mainSource.includes(required), `main-process update wiring omits ${required}`);
  }
});

test("both native wrappers load their installed platform packages", () => {
  const pty = require("@lydell/node-pty");
  const watcher = require("@parcel/watcher");

  assert.equal(typeof pty.spawn, "function");
  assert.equal(typeof watcher.subscribe, "function");
});

test("Linux desktop filename and runtime window identity stay synchronized", () => {
  assert.equal(packageMetadata.desktopName, "mirafold.desktop");
  assert.match(builderConfig, /(?:^|\n)\s*syncDesktopName:\s*true(?:\n|$)/);
});

test("the AppImage desktop entry does not disable Chromium's sandbox unconditionally", () => {
  assert.match(builderConfig, /(?:^|\n)appImage:\s*\n\s+executableArgs:\s*\[\](?:\n|$)/);
});
