#!/usr/bin/env node
/**
 * Interim standing reaper for wedged opencode-local model-call children.
 *
 * Context: the Paperclip local executor (`node cli/src/index.ts run --bind lan`)
 * spawns per-run opencode/claude children. When a model call hangs upstream,
 * the child can wedge in Ssl/sleeping state at ~0% CPU with no stdout progress.
 * The existing adapter timeout is disabled by default (timeoutSec=0), so the
 * supervisor waits indefinitely. This reaper detects that signature and SIGTERM
 * the child, letting the supervisor write the run result and recover.
 *
 * This is an interim guard until the adapter-level output-inactivity watchdog
 * (packages/adapters/opencode-local/src/server/output-inactivity-monitor.ts)
 * is deployed across the fleet.
 *
 * Usage:
 *   node scripts/opencode-local-wedged-reaper.mjs [--dry-run] [--min-etime-minutes 30]
 *
 * Recommend running from cron every 5 minutes on hosts running the local executor.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";

const DRY_RUN = process.argv.includes("--dry-run");
const MIN_ETIME_MINUTES = parseInt(
  process.argv.find((_, i, arr) => i > 0 && arr[i - 1] === "--min-etime-minutes") ?? "30",
  10,
);

if (Number.isNaN(MIN_ETIME_MINUTES) || MIN_ETIME_MINUTES < 1) {
  console.error("Invalid --min-etime-minutes; must be a positive integer.");
  process.exit(2);
}

function log(...args) {
  const ts = new Date().toISOString();
  console.log(ts, ...args);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    if (err.status === 1 && !err.stderr?.trim()) {
      // Common for ps/pgrep to exit 1 when no matches.
      return "";
    }
    throw err;
  }
}

function parseEtime(etime) {
  // ps etime formats: MM:SS, HH:MM:SS, or D-HH:MM:SS
  const trimmed = etime.trim();
  if (!trimmed) return Infinity;
  const parts = trimmed.split(/[-:]/).map((p) => parseInt(p, 10));
  if (parts.length === 2) {
    const [mm, ss] = parts;
    return mm * 60 + ss;
  }
  if (parts.length === 3 && !trimmed.includes("-")) {
    const [hh, mm, ss] = parts;
    return hh * 3600 + mm * 60 + ss;
  }
  if (parts.length === 4) {
    const [dd, hh, mm, ss] = parts;
    return dd * 86400 + hh * 3600 + mm * 60 + ss;
  }
  return Infinity;
}

function findSupervisorPids() {
  const out = run("pgrep", ["-f", "node .*run .*--bind\\s+lan"]);
  return out
    .split(/\r?\n/)
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function listChildren(ppid) {
  const out = run("pgrep", ["-P", String(ppid)]);
  return out
    .split(/\r?\n/)
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function describeProcess(pid) {
  // pid, ppid, etime, stat, %cpu, comm, args
  const out = run("ps", [
    "-p",
    String(pid),
    "-o",
    "pid=,ppid=,etime=,stat=,pcpu=,comm=,args=",
  ]);
  const line = out.split(/\r?\n/)[0]?.trim();
  if (!line) return null;
  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/,
  );
  if (!match) return null;
  const [, pidStr, ppidStr, etime, stat, pcpu, comm, args] = match;
  return {
    pid: parseInt(pidStr, 10),
    ppid: parseInt(ppidStr, 10),
    etime,
    etimeSec: parseEtime(etime),
    stat,
    pcpu: parseFloat(pcpu) || 0,
    comm,
    args,
  };
}

function isWedgedCandidate(proc) {
  // Sleeping/uninterruptible states with negligible CPU and long elapsed time.
  const isSleeping = /^[SD]/.test(proc.stat);
  const oldEnough = proc.etimeSec >= MIN_ETIME_MINUTES * 60;
  const lowCpu = proc.pcpu <= 1.0;
  return isSleeping && oldEnough && lowCpu;
}

function reap(pid, reason) {
  if (DRY_RUN) {
    log(`[dry-run] would SIGTERM ${pid}: ${reason}`);
    return false;
  }
  log(`SIGTERM ${pid}: ${reason}`);
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (err) {
    log(`Failed to SIGTERM ${pid}:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

function main() {
  const supervisors = findSupervisorPids();
  if (supervisors.length === 0) {
    log("No local executor supervisor (node ... run ... --bind lan) found.");
    return 0;
  }

  log(`Supervisors: ${supervisors.join(", ")}`);

  const candidates = new Map();
  for (const supervisorPid of supervisors) {
    for (const childPid of listChildren(supervisorPid)) {
      const proc = describeProcess(childPid);
      if (!proc) continue;
      proc.supervisorPid = supervisorPid;
      if (isWedgedCandidate(proc)) {
        candidates.set(childPid, proc);
      }
    }
  }

  if (candidates.size === 0) {
    log("No wedged children detected.");
    return 0;
  }

  let reaped = 0;
  for (const [pid, proc] of candidates) {
    const reason =
      `parent=${proc.supervisorPid} etime=${proc.etime} stat=${proc.stat} pcpu=${proc.pcpu} comm=${proc.comm}`;
    if (reap(pid, reason)) reaped += 1;
  }

  log(`Reaped ${reaped}/${candidates.size} wedged children.`);
  return 0;
}

process.exit(main());
