// The PATH problem, and why this file exists.
//
// A desktop app launched the way a desktop app is launched — a menu entry, a
// dock icon, Finder — does NOT inherit the PATH your shell builds. The shell's
// PATH is assembled by ~/.zshrc, ~/.bash_profile, nvm, asdf, volta, fnm and
// friends, none of which a GUI launcher ever sources. So the app sees a bare
// system PATH.
//
// That matters here more than in most apps: the daemon's whole job is to spawn
// `claude`, `codex` and `gemini`, which is exactly where those version managers
// put things. Without this the app installs fine, opens fine, and then reports
// that you have no coding agent installed — on a machine where you plainly do.
//
// Worst on macOS (Finder gives a famously minimal PATH), real on Linux too: a
// .desktop entry launched from the app menu inherits the session environment,
// not an interactive shell's.
//
// Deliberately NOT a dependency. `fix-path` and `shell-env` both solve this,
// and both are more machinery than the fifteen lines below — no protocol, no
// spec, no security-sensitive surface. Owning it is cheaper than auditing it.

import { execFile } from "node:child_process";

// An interactive login shell runs the user's whole profile, and a profile can
// do anything — including block on a prompt or a slow network call. Bound it:
// a wrong PATH is a bad error message, but a hung PATH lookup is an app that
// never opens at all.
const TIMEOUT_MS = 5000;

/**
 * The PATH an interactive login shell would have, or null if we can't get one.
 * `-i` (interactive) and `-l` (login) between them cover both conventions —
 * zsh puts PATH in .zshrc (interactive), bash in .bash_profile (login).
 */
function shellPath() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL;
    if (!shell) return resolve(null);
    execFile(
      shell,
      ["-ilc", 'printf "%s" "$PATH"'],
      { timeout: TIMEOUT_MS, encoding: "utf8" },
      (err, stdout) => {
        // Any failure at all — no such shell, non-zero exit, timeout, a profile
        // that writes junk to stdout — falls back to what we already had.
        if (err) return resolve(null);
        const value = String(stdout).trim();
        resolve(value.includes("/") ? value : null);
      },
    );
  });
}

/**
 * Environment for the daemon child process: our own, with PATH widened to what
 * the user's shell would see.
 *
 * Merged rather than replaced. The login shell's PATH is authoritative about
 * the user's tools, but the process PATH can carry entries the login shell
 * doesn't know about (a sandbox, a CI harness, a wrapper script) and dropping
 * those silently would be its own bug. Login entries go first — they're the
 * ones that should win a name collision, since they're what `which claude`
 * would find in the user's own terminal.
 */
export async function daemonEnv() {
  const env = { ...process.env };
  // Windows has no login-shell concept to consult, and its PATH is machine-wide
  // and inherited correctly by GUI apps already.
  if (process.platform === "win32") return env;

  const login = await shellPath();
  if (!login) return env;

  const seen = new Set();
  const merged = [];
  for (const dir of [...login.split(":"), ...(env.PATH ?? "").split(":")]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  env.PATH = merged.join(":");
  return env;
}
