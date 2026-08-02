// Tiny persisted state: which folder you had open last, so the second launch
// doesn't ask again. Lives in Electron's per-user data directory (~/.config on
// Linux, %APPDATA% on Windows) — never in the project folder, which the user
// may delete, move, or check into git.
//
// Deliberately hand-rolled rather than `electron-store`: this is one string in
// one JSON file. Every read is defensive because the file is user-writable and
// nothing here is worth crashing the app over — a corrupt state file should
// cost you the folder picker once, not the ability to start.

import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const file = () => path.join(app.getPath("userData"), "state.json");

function read() {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // absent, unreadable, or not JSON — all mean "no state yet"
  }
}

/** The last folder opened, or null. */
export function lastFolder() {
  const value = read().lastFolder;
  return typeof value === "string" && value ? value : null;
}

/** Remember a folder. Best-effort: a failed write must never break a launch. */
export function setLastFolder(folder) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(file(), JSON.stringify({ ...read(), lastFolder: folder }, null, 2));
  } catch {
    /* not worth surfacing — the cost is one extra folder prompt next time */
  }
}
