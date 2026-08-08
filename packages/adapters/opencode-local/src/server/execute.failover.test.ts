import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THA-422: cross-provider failover on provider-exhaustion. These tests stub the
// OpenCode process runner so a forced `AI_APICallError` usage-limit on the
// PRIMARY model drives the adapter onto the FALLBACK model WITHOUT touching the
// live provider accounts (exhausting the live account re-creates the THA-396
// fleet outage). They assert the run completes on the fallback and attributes
// provider/biller/model to the serving provider (THA-386 reconciliation).
//
// THA-6649: extends coverage to hung primary lanes. A hung lane emits no
// exhaustion signal — the inactivity monitor fires and kills the process, leaving
// exitCode=null and no error JSON. The hang failover tests use fake timers to
// fire the inactivity monitor while the primary "process" is still running.

const PRIMARY = "zai-coding-plan/glm-5.2";
const FALLBACK = "kimi-for-coding/kimi-k2";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} = vi.hoisted(() => {
  const PRIMARY = "zai-coding-plan/glm-5.2";
  const FALLBACK = "kimi-for-coding/kimi-k2";
  const now = () => new Date().toISOString();

  const usageLimitStdout = JSON.stringify({
    type: "error",
    error: { message: "Usage limit for this billing period." },
  });

  const successStdout = [
    JSON.stringify({ type: "text", sessionID: "session_fallback", part: { text: "ok" } }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "session_fallback",
      part: { cost: 0.001, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    }),
  ].join("\n");

  return {
    // The local execution path delegates run attempts to runChildProcess; we
    // differentiate by the `--model` value so the primary "exhausts" and the
    // fallback succeeds, without any real provider traffic.
    runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("run")) {
        const modelIdx = args.indexOf("--model");
        const model = modelIdx >= 0 ? args[modelIdx + 1] : "";
        if (model === PRIMARY) {
          return { exitCode: 1, signal: null, timedOut: false, stdout: usageLimitStdout, stderr: "", pid: 11, startedAt: now() };
        }
        if (model === FALLBACK) {
          return { exitCode: 0, signal: null, timedOut: false, stdout: successStdout, stderr: "", pid: 12, startedAt: now() };
        }
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 1, startedAt: now() };
    }),
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "opencode"),
    // Neutralize host-side skill symlink injection (local-only side effect) so
    // the test never mutates the real ~/.claude/skills.
    readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
    removeMaintainerOnlySkillSymlinks: vi.fn(async () => []),
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
    ensureCommandResolvable,
    resolveCommandForLogs,
    readPaperclipRuntimeSkillEntries,
    removeMaintainerOnlySkillSymlinks,
  };
});

import { execute } from "./execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

describe("opencode-local cross-provider failover (THA-422)", () => {
  const prevAllowAll = process.env.OPENCODE_ALLOW_ALL_MODELS;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    // Skip the local `opencode models` availability probe so the stubbed
    // runChildProcess is only invoked for the run attempts themselves.
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    // Isolate any host-side home-directory access from skill/config helpers.
    process.env.HOME = os.tmpdir();
    runChildProcess.mockClear();
    ensureCommandResolvable.mockClear();
  });

  afterEach(() => {
    if (prevAllowAll === undefined) delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    else process.env.OPENCODE_ALLOW_ALL_MODELS = prevAllowAll;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  function buildCtx(overrides: {
    fallbackModels?: string[];
    model?: string;
    outputInactivityTimeoutMs?: number;
  }): AdapterExecutionContext {
    return {
      runId: "run-failover-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode IC",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "opencode",
        model: overrides.model ?? PRIMARY,
        ...(overrides.fallbackModels ? { fallbackModels: overrides.fallbackModels } : {}),
        ...(overrides.outputInactivityTimeoutMs != null
          ? { outputInactivityTimeoutMs: overrides.outputInactivityTimeoutMs }
          : {}),
        // Avoid the runtime-config fs dance; not relevant to failover behaviour.
        dangerouslySkipPermissions: false,
        cwd: path.join(os.tmpdir(), "paperclip-failover-test"),
      },
      context: {
        paperclipWorkspace: { cwd: path.join(os.tmpdir(), "paperclip-failover-test"), source: "project_primary" },
      },
      onLog: async () => {},
    } as unknown as AdapterExecutionContext;
  }

  function modelUsedInCall(args: string[] | undefined): string | undefined {
    if (!args) return undefined;
    const idx = args.indexOf("--model");
    return idx >= 0 ? args[idx + 1] : undefined;
  }

  it("fails over to the fallback model on a primary usage-limit error and attributes the serving provider", async () => {
    const logs: string[] = [];
    const ctx = buildCtx({ fallbackModels: [FALLBACK] });
    ctx.onLog = async (_stream, chunk) => {
      logs.push(chunk);
    };

    const result = await execute(ctx);

    // The run COMPLETED on the fallback, not a stall.
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("ok");

    // THA-386 attribution: provider/biller/model reflect the FALLBACK, not the primary.
    expect(result.model).toBe(FALLBACK);
    expect(result.provider).toBe("kimi-for-coding");
    expect(result.biller).toBe("kimi-for-coding");

    // A fallback-provider session must not be resumed by the next heartbeat's
    // primary --model, so the stored session is forced to clear.
    expect(result.clearSession).toBe(true);

    // Two run attempts: primary (exhausted) then fallback (fresh session, no --session).
    const runCalls = runChildProcess.mock.calls.filter((call) => Array.isArray(call[2]) && call[2].includes("run"));
    expect(runCalls).toHaveLength(2);
    expect(modelUsedInCall(runCalls[0]?.[2])).toBe(PRIMARY);
    expect(modelUsedInCall(runCalls[1]?.[2])).toBe(FALLBACK);
    expect(runCalls[1]?.[2]).not.toContain("--session");

    // Failover is observable in the run logs.
    expect(logs.some((line) => /failing over to/.test(line) && line.includes(FALLBACK))).toBe(true);
    expect(logs.some((line) => /failover succeeded/.test(line))).toBe(true);
  });

  it("does not fail over when no fallbackModels are configured (single attempt, error surfaced)", async () => {
    const result = await execute(buildCtx({}));

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Usage limit for this billing period");
    // Attribution stays on the exhausted primary.
    expect(result.model).toBe(PRIMARY);
    expect(result.provider).toBe("zai-coding-plan");
  });

  it("does not fail over on a non-exhaustion error (e.g. model not found)", async () => {
    runChildProcess.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ type: "error", error: { message: "model not found: zai-coding-plan/glm-5.2" } }),
      stderr: "",
      pid: 21,
      startedAt: new Date().toISOString(),
    }));

    const result = await execute(buildCtx({ fallbackModels: [FALLBACK] }));

    // Only the primary was tried; the non-exhaustion error is surfaced directly.
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.model).toBe(PRIMARY);
  });

  // THA-6649: hang failover — the inactivity monitor fires, primary emits no
  // output and no error JSON. Without this fix, initialFailed=false and the
  // failover block is skipped entirely; the run dies with an inactivity error.
  //
  // We use vi.useFakeTimers() and advance the clock from *inside* the primary
  // runChildProcess mock. That way the timer is already registered (the monitor
  // is set up inside runAttempt before runChildProcess is called), and advancing
  // fake time fires the inactivity callback immediately — setting monitorFired=true
  // before the mock returns, which is all the fix needs.
  it("fails over to the fallback when the primary model hangs (inactivity monitor fires)", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];

    runChildProcess.mockImplementationOnce(async (_runId: string, _command: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("run")) {
        // Advance past the inactivity timeout so the monitor fires (sets monitorFired=true).
        // The monitor is already registered at this point (runAttempt sets it up before
        // calling runChildProcess). killTarget is null (mock never calls onSpawn), so the
        // signal path is a no-op — only monitorFired=true matters for the fix.
        await vi.advanceTimersByTimeAsync(200);
        // Return what a SIGTERM-killed process looks like: null exitCode, no stdout.
        // Cast required: a SIGTERM-killed process has exitCode:null and a string signal,
        // which doesn't match the mock's narrow generic return type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { exitCode: null, signal: "SIGTERM", timedOut: false, stdout: "", stderr: "", pid: 11, startedAt: new Date().toISOString() } as any;
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 1, startedAt: new Date().toISOString() };
    });

    const ctx = buildCtx({ fallbackModels: [FALLBACK], outputInactivityTimeoutMs: 100 });
    ctx.onLog = async (_stream, chunk) => { logs.push(chunk); };

    const result = await execute(ctx);
    vi.useRealTimers();

    // Failover completed on the fallback.
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("ok");

    // Attribution reflects the FALLBACK, not the hung primary.
    expect(result.model).toBe(FALLBACK);
    expect(result.provider).toBe("kimi-for-coding");

    // Session must be cleared so the next heartbeat doesn't try to resume on the primary.
    expect(result.clearSession).toBe(true);

    // Two run calls: primary (hung) + fallback (fresh).
    const runCalls = runChildProcess.mock.calls.filter((call) => Array.isArray(call[2]) && call[2].includes("run"));
    expect(runCalls).toHaveLength(2);
    expect(modelUsedInCall(runCalls[0]?.[2])).toBe(PRIMARY);
    expect(modelUsedInCall(runCalls[1]?.[2])).toBe(FALLBACK);

    // Failover reason logged as "hung", not "provider-exhaustion".
    expect(logs.some((line) => /hung/.test(line) && /failing over to/.test(line) && line.includes(FALLBACK))).toBe(true);
    expect(logs.some((line) => /failover succeeded/.test(line))).toBe(true);
  });

  it("does not fail over on a hang when no fallbackModels are configured", async () => {
    vi.useFakeTimers();

    runChildProcess.mockImplementationOnce(async (_runId: string, _command: string, args: string[]) => {
      if (Array.isArray(args) && args.includes("run")) {
        await vi.advanceTimersByTimeAsync(200);
        // Cast required: a SIGTERM-killed process has exitCode:null and a string signal,
        // which doesn't match the mock's narrow generic return type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { exitCode: null, signal: "SIGTERM", timedOut: false, stdout: "", stderr: "", pid: 11, startedAt: new Date().toISOString() } as any;
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 1, startedAt: new Date().toISOString() };
    });

    const result = await execute(buildCtx({ outputInactivityTimeoutMs: 100 }));
    vi.useRealTimers();

    // Only one attempt; the inactivity error is surfaced directly.
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("opencode_output_inactivity_monitor");
    expect(result.model).toBe(PRIMARY);
  });
});
