import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "./context-overflow.js";

describe("isContextOverflowError", () => {
  it("detects the Anthropic 'prompt is too long: N tokens > M maximum' wording", () => {
    expect(
      isContextOverflowError({
        errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        stderr: "API Error: prompt is too long: 250000 tokens > 200000 maximum",
      }),
    ).toBe(true);
  });

  it("detects OpenAI context_length_exceeded and the reduce-the-messages guidance", () => {
    expect(
      isContextOverflowError({
        parsedErrorMessages: [
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 12000 tokens.",
        ],
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        errorMessage: "Please reduce the length of the messages.",
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        stderr: "Error: context_length_exceeded",
      }),
    ).toBe(true);
  });

  it("detects generic prompt-too-long / input-length-exceeds phrasing", () => {
    expect(isContextOverflowError({ errorMessage: "Prompt too long" })).toBe(true);
    expect(isContextOverflowError({ errorMessage: "Your input is too long" })).toBe(true);
    expect(
      isContextOverflowError({ errorMessage: "Input length exceeds the maximum allowed tokens" }),
    ).toBe(true);
  });

  it("does not classify rate-limit / usage-limit wording as overflow", () => {
    expect(
      isContextOverflowError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(false);
    expect(
      isContextOverflowError({ stderr: "HTTP 429: Too Many Requests" }),
    ).toBe(false);
    expect(
      isContextOverflowError({ errorMessage: "Overloaded. Try again later." }),
    ).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(isContextOverflowError({})).toBe(false);
    expect(isContextOverflowError({ errorMessage: "   " })).toBe(false);
  });
});
