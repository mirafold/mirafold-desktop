// Tiny persisted state: which folder you had open last and the whole-interface
// scale you chose. Lives in Electron's per-user data directory (~/.config on
// Linux, %APPDATA% on Windows) — never in the project folder, which the user
// may delete, move, or check into git.
//
// Deliberately hand-rolled rather than `electron-store`: this is one string and
// one number in one JSON file. Every read is defensive because the file is
// user-writable and neither value is worth crashing the app over — corrupt
// state should cost you a preference, not the ability to start.

import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_INTERFACE_SCALE,
  isInterfaceScale,
} from "./interface-scale.js";

const file = () => path.join(app.getPath("userData"), "state.json");

function read() {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // absent, unreadable, or not JSON — all mean "no state yet"
  }
}

function write(values) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(file(), JSON.stringify({ ...read(), ...values }, null, 2));
  } catch {
    /* best-effort preferences must never prevent Mirafold from running */
  }
}

/** The last folder opened, or null. */
export function lastFolder() {
  const value = read().lastFolder;
  return typeof value === "string" && value ? value : null;
}

/** Remember a folder. Best-effort: a failed write must never break a launch. */
export function setLastFolder(folder) {
  write({ lastFolder: folder });
}

/** The remembered whole-interface scale, defaulting safely to 100%. */
export function interfaceScale() {
  const value = read().interfaceScale;
  return isInterfaceScale(value) ? value : DEFAULT_INTERFACE_SCALE;
}

/** Remember a validated interface scale without disturbing other state. */
export function setInterfaceScale(scale) {
  if (isInterfaceScale(scale)) write({ interfaceScale: scale });
}
