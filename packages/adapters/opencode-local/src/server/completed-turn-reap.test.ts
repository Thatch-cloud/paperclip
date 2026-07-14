import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

const COMPLETED_TURN_STDOUT = [
  JSON.stringify({ type: "text", sessionID: "ses_reap", part: { text: "Turn completed successfully" } }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_reap",
    part: { cost: 0.001, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 0 } } },
  }),
].join("\n");

function makeAgent() {
  return {
    id: "agent-reap-test",
    companyId: "company-reap-test",
    name: "Reap Test Agent",
    adapterType: "opencode_local" as const,
    adapterConfig: {},
  };
}

function makeBaseConfig() {
  return {
    command: "fake-opencode",
    model: "anthropic/test/model",
    outputInactivityTimeoutMs: 100,
  };
}

function makeBaseContext(cwd: string) {
  return {
    paperclipWorkspace: { cwd, source: "project_primary" as const },
  };
}

describe("opencode-local completed-turn reap on monitor fire", () => {
  const originalAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalAllowAllModels === undefined) {
      delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    } else {
      process.env.OPENCODE_ALLOW_ALL_MODELS = originalAllowAllModels;
    }
  });

  it("preserves successful semantics when the monitor reaps a child that completed the turn", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "true";

    // Simulate an opencode child that emits step_finish then hangs. The mock
    // feeds stdout via onLog (arming the inactivity monitor), waits long
    // enough for the monitor timer to fire, then returns a SIGTERM'd result.
    runChildProcess.mockImplementation(
      async (
        _runId: string,
        _command: string,
        _args: string[],
        opts: {
          onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
          onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        },
      ) => {
        if (opts.onSpawn) {
          await opts.onSpawn({ pid: 999_999, processGroupId: null, startedAt: new Date().toISOString() });
        }
        // Feed the completed-turn JSONL to the monitor via onLog.
        await opts.onLog("stdout", COMPLETED_TURN_STDOUT + "\n");
        // Wait for the monitor's 100 ms timer to fire.
        await new Promise((resolve) => setTimeout(resolve, 350));
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          stdout: COMPLETED_TURN_STDOUT,
          stderr: "exiting loop\n",
          pid: 999_999,
          startedAt: new Date().toISOString(),
        };
      },
    );

    const result = await execute({
      runId: "run-reap-completed",
      agent: makeAgent(),
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: makeBaseConfig(),
      context: makeBaseContext(process.cwd()),
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.summary).toBe("Turn completed successfully");
    expect(result.sessionId).toBe("ses_reap");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
  });

  it("surfaces a monitor failure when the child hangs WITHOUT completing the turn", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "true";

    const incompleteStdout = JSON.stringify({
      type: "text",
      sessionID: "ses_hang",
      part: { text: "I am stuck mid-turn..." },
    });

    runChildProcess.mockImplementation(
      async (
        _runId: string,
        _command: string,
        _args: string[],
        opts: {
          onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
          onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        },
      ) => {
        if (opts.onSpawn) {
          await opts.onSpawn({ pid: 999_998, processGroupId: null, startedAt: new Date().toISOString() });
        }
        await opts.onLog("stdout", incompleteStdout + "\n");
        await new Promise((resolve) => setTimeout(resolve, 350));
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          stdout: incompleteStdout,
          stderr: "",
          pid: 999_998,
          startedAt: new Date().toISOString(),
        };
      },
    );

    const result = await execute({
      runId: "run-reap-incomplete",
      agent: makeAgent(),
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: makeBaseConfig(),
      context: makeBaseContext(process.cwd()),
      onLog: async () => {},
    });

    // No step_finish → genuine hang → monitor failure (existing behaviour).
    expect(result.errorMessage).toContain("monitor: no opencode output");
    expect(result.errorCode).toBe("opencode_output_inactivity_monitor");
  });
});
