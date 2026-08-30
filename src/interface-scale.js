// Browser-style whole-page scaling for Mirafold's one desktop viewport.
//
// The daemon receives a fresh loopback origin on every boot. Chromium's
// ordinary zoom ownership is origin-scoped, so Desktop owns one device-level
// value instead and reapplies it whenever a page finishes loading. Keeping the
// policy pure here makes every level, boundary, and state transition testable
// without an Electron window.

export const DEFAULT_INTERFACE_SCALE = 1;

export const INTERFACE_SCALES = Object.freeze([
  0.5,
  0.67,
  0.75,
  0.8,
  0.9,
  DEFAULT_INTERFACE_SCALE,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
]);

export function isInterfaceScale(value) {
  return typeof value === "number" && INTERFACE_SCALES.includes(value);
}

export function normalizeInterfaceScale(value) {
  return isInterfaceScale(value) ? value : DEFAULT_INTERFACE_SCALE;
}

/** Map browser-familiar local shortcuts without depending on keyboard layout. */
export function interfaceScaleShortcut(input, platform = process.platform) {
  if (!input || input.type !== "keyDown" || input.alt || input.isComposing) return null;
  const commandDown = platform === "darwin" ? input.meta : input.control;
  if (!commandDown) return null;

  if (["+", "="].includes(input.key) || ["Equal", "NumpadAdd"].includes(input.code)) {
    return "in";
  }
  if (["-", "_"].includes(input.key) || ["Minus", "NumpadSubtract"].includes(input.code)) {
    return "out";
  }
  if (input.key === "0" || ["Digit0", "Numpad0"].includes(input.code)) return "reset";
  return null;
}

function adjacentScale(current, offset) {
  const index = INTERFACE_SCALES.indexOf(normalizeInterfaceScale(current));
  const nextIndex = Math.max(0, Math.min(INTERFACE_SCALES.length - 1, index + offset));
  return INTERFACE_SCALES[nextIndex];
}

/**
 * Own the remembered scale independently of any particular daemon page.
 * Applying after navigation deliberately does not persist again: only a user
 * command changes state, while page loads merely receive that choice.
 */
export function createInterfaceScaleController({
  initialScale,
  applyScale,
  persistScale,
}) {
  let scale = normalizeInterfaceScale(initialScale);

  function apply() {
    applyScale(scale);
    return scale;
  }

  function select(nextScale) {
    if (!isInterfaceScale(nextScale)) return scale;
    if (nextScale === scale) return scale;
    scale = nextScale;
    apply();
    persistScale(scale);
    return scale;
  }

  return {
    get scale() {
      return scale;
    },
    apply,
    reset: () => select(DEFAULT_INTERFACE_SCALE),
    zoomIn: () => select(adjacentScale(scale, 1)),
    zoomOut: () => select(adjacentScale(scale, -1)),
  };
}
