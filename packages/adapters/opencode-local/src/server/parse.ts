import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export function hasOpenCodeCompletedTurn(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    if (asString(event.type, "") === "step_finish") return true;
  }

  return false;
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

// Cross-provider failover trigger set (THA-422). These are transient
// provider-exhaustion / upstream-capacity conditions where re-trying the SAME
// provider/model is unlikely to help, but a different already-authed provider
// (configured via adapterConfig.fallbackModels) may be healthy. Each branch
// matches a class of real provider wording rather than a single literal:
//   1. Usage / billing-limit exhaustion — the THA-396 outage class. The AI SDK
//      surfaces these as `AI_APICallError` with messages such as "Usage limit
//      for this billing period". The spec anchor is
//      `/usage limit for this (billing cycle|period)/i`; the surrounding
//      patterns catch the common synonyms providers emit.
//   2. Rate limiting (HTTP 429 family).
//   3. Provider overload / capacity (HTTP 529 / 503).
//   4. Connection failures reaching the provider (transient upstream).
//
// Intentionally NOT matched: "model not found" / "model unavailable" (a
// configuration/availability error, not provider exhaustion) and generic
// non-transient auth errors — those should surface as ordinary failures.
const OPENCODE_PROVIDER_EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /usage limit for this (?:billing cycle|billing period)/i,
  /(?:exceeded|exhausted|reached|hit)\b.{0,40}?\b(?:usage|rate|quota|token|request|limit|credit|balance)/i,
  /quota (?:exceed|exhaust)/i,
  /insufficient (?:credit|balance|funds)/i,
  /\bpayment required\b|\b402\b/i,
  /\b429\b|rate[\s-]?limit/i,
  /\b529\b|\b503\b|overload(?:ed)?|service unavailable|provider capacity/i,
  /\b(?:econnrefused|econnreset|etimedout|enotfound)\b|connection (?:refused|reset|timed out|failed)|fetch failed|network error/i,
];

export function isOpenCodeProviderExhaustionError(
  errorMessage: string | null | undefined,
): boolean {
  if (!errorMessage) return false;
  const haystack = `${errorMessage}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (!haystack) return false;
  return OPENCODE_PROVIDER_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(haystack));
}
