// Pins the 2026-08-03 bug: a login shell whose startup files print to stdout
// (a greeting echo, neofetch, Ubuntu's stock sudo hint) got that text glued
// onto the first PATH entry — destroying exactly the version-manager shim
// directory login-env.js exists to recover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test(
  "daemonEnv survives a chatty shell profile",
  { skip: process.platform === "win32" && "no login shell on Windows" },
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "mirafold-loginenv-"));
    writeFileSync(
      path.join(home, ".bash_profile"),
      'echo "Welcome back!"\nexport PATH="/opt/fake-nvm/bin:$PATH"\n',
    );
    process.env.SHELL = "/bin/bash";
    process.env.HOME = home;

    const { daemonEnv } = await import("../src/login-env.js");
    const entries = (await daemonEnv()).PATH.split(":");

    assert.ok(
      entries.includes("/opt/fake-nvm/bin"),
      `login PATH's first entry lost; got: ${JSON.stringify(entries.slice(0, 3))}`,
    );
    for (const entry of entries) {
      assert.ok(!entry.includes("\n"), `profile output leaked in: ${JSON.stringify(entry)}`);
    }
  },
);
