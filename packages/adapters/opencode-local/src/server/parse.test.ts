import { describe, expect, it } from "vitest";
import {
  parseOpenCodeJsonl,
  isOpenCodeUnknownSessionError,
  isOpenCodeProviderExhaustionError,
} from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("isOpenCodeProviderExhaustionError", () => {
  it("matches the THA-396 usage-limit class and its provider synonyms", () => {
    expect(isOpenCodeProviderExhaustionError("Usage limit for this billing period.")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("usage limit for this billing cycle reached")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("You exceeded your current quota.")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("insufficient credit balance")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("402 Payment Required")).toBe(true);
  });

  it("matches rate-limit, overload, and connection-failure triggers", () => {
    expect(isOpenCodeProviderExhaustionError("429 Too Many Requests")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("rate-limit exceeded")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("overloaded")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("Error 529: The model is overloaded")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("fetch failed: ECONNREFUSED")).toBe(true);
    expect(isOpenCodeProviderExhaustionError("connection timed out")).toBe(true);
  });

  it("does not match config/availability or ordinary errors", () => {
    expect(isOpenCodeProviderExhaustionError(null)).toBe(false);
    expect(isOpenCodeProviderExhaustionError("")).toBe(false);
    expect(isOpenCodeProviderExhaustionError("model not found: foo/bar")).toBe(false);
    expect(isOpenCodeProviderExhaustionError("model unavailable")).toBe(false);
    expect(isOpenCodeProviderExhaustionError("unknown session id")).toBe(false);
    expect(isOpenCodeProviderExhaustionError("syntax error near token")).toBe(false);
  });
});
