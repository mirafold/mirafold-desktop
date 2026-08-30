import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInterfaceScaleController,
  DEFAULT_INTERFACE_SCALE,
  INTERFACE_SCALES,
  interfaceScaleShortcut,
  isInterfaceScale,
  normalizeInterfaceScale,
} from "../src/interface-scale.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("interface scales are deliberate browser-like levels with a safe default", () => {
  assert.deepEqual(INTERFACE_SCALES, [
    0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
  ]);
  assert.equal(DEFAULT_INTERFACE_SCALE, 1);
  assert.equal(isInterfaceScale(1.25), true);
  assert.equal(isInterfaceScale(1.2), false);
  assert.equal(isInterfaceScale("1.25"), false);
  for (const invalid of [undefined, null, NaN, Infinity, 0, 1.2, 4, "1"]) {
    assert.equal(normalizeInterfaceScale(invalid), 1);
  }
});

test("keyboard mapping accepts browser aliases and the platform command modifier", () => {
  const keyDown = {
    type: "keyDown",
    key: "=",
    code: "Equal",
    control: true,
    meta: false,
    alt: false,
    isComposing: false,
  };
  assert.equal(interfaceScaleShortcut(keyDown, "linux"), "in");
  assert.equal(interfaceScaleShortcut({ ...keyDown, key: "+" }, "win32"), "in");
  assert.equal(interfaceScaleShortcut({ ...keyDown, key: "-", code: "Minus" }, "linux"), "out");
  assert.equal(interfaceScaleShortcut({ ...keyDown, key: "0", code: "Digit0" }, "win32"), "reset");
  assert.equal(
    interfaceScaleShortcut({ ...keyDown, key: "+", code: "NumpadAdd" }, "linux"),
    "in",
  );
  assert.equal(
    interfaceScaleShortcut({ ...keyDown, control: false, meta: true }, "darwin"),
    "in",
  );
  assert.equal(interfaceScaleShortcut({ ...keyDown, control: false }, "linux"), null);
  assert.equal(interfaceScaleShortcut({ ...keyDown, meta: true }, "darwin"), "in");
  assert.equal(interfaceScaleShortcut({ ...keyDown, alt: true }, "linux"), null);
  assert.equal(interfaceScaleShortcut({ ...keyDown, type: "keyUp" }, "linux"), null);
  assert.equal(interfaceScaleShortcut({ ...keyDown, isComposing: true }, "linux"), null);
  assert.equal(interfaceScaleShortcut({ ...keyDown, key: "x", code: "KeyX" }, "linux"), null);
});

test("zoom commands step, clamp, reset, persist changes, and only reapply on navigation", () => {
  const applied = [];
  const persisted = [];
  const controller = createInterfaceScaleController({
    initialScale: 1.25,
    applyScale: (scale) => applied.push(scale),
    persistScale: (scale) => persisted.push(scale),
  });

  assert.equal(controller.scale, 1.25);
  assert.equal(controller.apply(), 1.25);
  assert.deepEqual(applied, [1.25]);
  assert.deepEqual(persisted, [], "navigation reapplication must not rewrite state");

  assert.equal(controller.zoomIn(), 1.5);
  assert.equal(controller.zoomOut(), 1.25);
  assert.equal(controller.reset(), 1);
  assert.deepEqual(applied, [1.25, 1.5, 1.25, 1]);
  assert.deepEqual(persisted, [1.5, 1.25, 1]);

  for (let index = 0; index < INTERFACE_SCALES.length + 2; index += 1) {
    controller.zoomIn();
  }
  assert.equal(controller.scale, 3);
  const writesAtMaximum = persisted.length;
  controller.zoomIn();
  assert.equal(persisted.length, writesAtMaximum, "the upper bound must not rewrite state");

  for (let index = 0; index < INTERFACE_SCALES.length + 2; index += 1) {
    controller.zoomOut();
  }
  assert.equal(controller.scale, 0.5);
  const writesAtMinimum = persisted.length;
  controller.zoomOut();
  assert.equal(persisted.length, writesAtMinimum, "the lower bound must not rewrite state");
});

test("an invalid remembered scale starts at 100%", () => {
  const applied = [];
  const controller = createInterfaceScaleController({
    initialScale: 99,
    applyScale: (scale) => applied.push(scale),
    persistScale: () => assert.fail("normalization must not overwrite user state on read"),
  });
  assert.equal(controller.scale, 1);
  controller.apply();
  assert.deepEqual(applied, [1]);
});

const STATE_PROBE = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import assert from "node:assert/strict";

const userData = process.argv[1];
const stateFile = path.join(userData, "state.json");
const app = {
  getPath(name) {
    assert.equal(name, "userData");
    return userData;
  },
};
mock.module("electron", { namedExports: { app } });

const state = await import(new URL("./src/state.js?interface-scale-state-probe", import.meta.url));
assert.equal(state.lastFolder(), null);
assert.equal(state.interfaceScale(), 1);

state.setLastFolder("/remembered-project");
state.setInterfaceScale(1.25);
assert.equal(state.lastFolder(), "/remembered-project");
assert.equal(state.interfaceScale(), 1.25);
assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
  lastFolder: "/remembered-project",
  interfaceScale: 1.25,
});

state.setInterfaceScale(1.2);
assert.equal(state.interfaceScale(), 1.25, "an unsupported value must not be stored");

writeFileSync(stateFile, JSON.stringify({
  lastFolder: "/preserved-project",
  interfaceScale: 99,
}));
assert.equal(state.interfaceScale(), 1, "invalid persisted data must fall back safely");
state.setInterfaceScale(0.9);
assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
  lastFolder: "/preserved-project",
  interfaceScale: 0.9,
});

process.stdout.write("state probe passed\n");
`;

test("desktop state validates scale and preserves the folder field in both directions", (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), "mirafold-interface-scale-"));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      STATE_PROBE,
      userData,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
  assert.match(result.stdout, /state probe passed/);
});
