import { describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createOpenCodeOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
} from "./output-inactivity-monitor.js";

const FAKE_OPENCODE_SCRIPT = `
process.stdout.write(JSON.stringify({ type: "text", part: { text: "hello" } }) + "\\n");
// Simulate a wedged opencode: read stdin forever, never write again.
process.stdin.resume();
process.stdin.on("data", () => {});
setInterval(() => {}, 60_000);
`;

describe("opencode inactivity monitor (integration: real subprocess)", () => {
  it(
    "kills an opencode child that goes silent after one event and surfaces a monitor failure",
    async () => {
      const runId = `opencode-monitor-integration-${Date.now()}`;
      const timeoutMs = 250;
      const logs: Array<{ stream: string; chunk: string }> = [];
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let monitorFired = false;
      let terminationSignal: NodeJS.Signals | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      let elapsedMs = 0;

      const kill = (signal: NodeJS.Signals) => {
        const target = killTarget;
        if (!target) return false;
        if (target.processGroupId && target.processGroupId > 0) {
          try {
            process.kill(-target.processGroupId, signal);
            return true;
          } catch {
            /* fall through */
          }
        }
        if (target.pid && target.pid > 0) {
          try {
            process.kill(target.pid, signal);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      };

      const monitor = createOpenCodeOutputInactivityMonitor({
        timeoutMs,
        onFire: (state) => {
          monitorFired = true;
          elapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
          if (kill("SIGTERM")) terminationSignal = "SIGTERM";
          sigkillTimer = setTimeout(() => {
            if (kill("SIGKILL")) terminationSignal = "SIGKILL";
          }, OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
        },
      });

      try {
        const proc = await runChildProcess(runId, process.execPath, ["-e", FAKE_OPENCODE_SCRIPT], {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutSec: 30,
          graceSec: 1,
          onSpawn: async (meta) => {
            killTarget = { pid: meta.pid, processGroupId: meta.processGroupId };
          },
          onLog: async (stream, chunk) => {
            logs.push({ stream, chunk });
            if (stream === "stdout") {
              monitor.noteStdoutChunk(chunk);
            }
          },
        });

        expect(monitorFired, "monitor should fire when opencode goes silent").toBe(true);
        expect(proc.timedOut).toBe(false);
        expect(["SIGTERM", "SIGKILL"]).toContain(proc.signal);
        expect(["SIGTERM", "SIGKILL"]).toContain(terminationSignal);
        expect(formatOutputInactivityMonitorErrorMessage(elapsedMs)).toMatch(
          /^monitor: no opencode output for \d+m \d+s$/,
        );
        expect(monitor.state().parsedEventCount).toBe(1);
      } finally {
        monitor.stop();
        if (sigkillTimer) clearTimeout(sigkillTimer);
      }
    },
    15_000,
  );
});
