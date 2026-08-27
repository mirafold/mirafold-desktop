// Electron starts this file in its Node-compatible mode so the packaged app
// can run Mirafold Shell without a separately installed Node.js. Keep that
// implementation detail inside this one process: Shell and every agent it
// starts must inherit an ordinary environment, not ELECTRON_RUN_AS_NODE.

const { appendFileSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PID_LEDGER_ENV = "MIRAFOLD_DESKTOP_PID_LEDGER";
const PROBE_DIAGNOSTICS_ENV = "MIRAFOLD_PROBE_DIAGNOSTICS";
const probeStartedAt = process.hrtime.bigint();

function writeProbeStage(stage) {
  if (process.env[PROBE_DIAGNOSTICS_ENV] !== "1") return;
  const elapsedMs = Number(process.hrtime.bigint() - probeStartedAt) / 1_000_000;
  process.stdout.write(`[mirafold-probe-stage] bootstrap:${stage}:${elapsedMs.toFixed(1)}ms\n`);
}

function linuxProcessStartTime(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) throw new Error(`cannot identify pseudo-terminal process ${pid}`);
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) {
    throw new Error(`cannot identify pseudo-terminal process ${pid}`);
  }
  return fields[19];
}

function stopUnownedPty(ptyProcess) {
  try {
    process.kill(-ptyProcess.pid, "SIGKILL");
  } catch {
    try {
      ptyProcess.kill("SIGKILL");
    } catch {
      // The process exited while its failed ownership record was handled.
    }
  }
}

function installLinuxPtyOwnership(ledgerFile) {
  if (process.platform !== "linux" || !ledgerFile) return;
  const pty = require("@lydell/node-pty");
  const originalSpawn = pty.spawn;

  pty.spawn = function ownedPtySpawn(...args) {
    const child = originalSpawn.apply(this, args);
    try {
      const startTime = linuxProcessStartTime(child.pid);
      appendFileSync(ledgerFile, `${child.pid}:${startTime}\n`, { encoding: "utf8" });
    } catch (error) {
      // A PTY that cannot be registered must not be allowed to outlive Shell.
      stopUnownedPty(child);
      throw error;
    }
    return child;
  };
}

async function main() {
  writeProbeStage("started");
  const daemonEntry = process.argv[2];
  if (!daemonEntry) throw new Error("missing Mirafold daemon entry point");

  const ledgerFile = process.env[PID_LEDGER_ENV] ?? null;
  delete process.env[PID_LEDGER_ENV];
  delete process.env.ELECTRON_RUN_AS_NODE;
  installLinuxPtyOwnership(ledgerFile);

  // Make Shell see the same argv shape it would receive if Electron had
  // launched its entry point directly rather than passing through this file.
  process.argv = [process.argv[0], daemonEntry, ...process.argv.slice(3)];
  writeProbeStage("shell-import-starting");
  await import(pathToFileURL(path.resolve(daemonEntry)).href);
  writeProbeStage("shell-import-returned");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
