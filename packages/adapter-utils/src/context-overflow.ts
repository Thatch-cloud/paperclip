// Matches context-window / prompt-length overflow failures reported by
// upstream model APIs (Anthropic, OpenAI, and their CLI wrappers).
//
// These are NOT transient: resending the same prompt on the same session will
// keep failing and burn real quota on runs that can never succeed. Callers must
// rotate to a fresh session before retrying (see the heartbeat context-overflow
// recovery path). The pattern is intentionally narrow so it does not swallow
// rate-limit / usage-limit wording, which belongs to transient_upstream.
const CONTEXT_OVERFLOW_ERROR_RE =
  /(?:\b(?:prompt|input)(?:[ _-]+is)?[ _-]+too[ _-]+long\b|\bcontext[ _-]+(?:length|window)[ _-]+(?:exceeded|reached)\b|\bcontext_length_exceeded\b|\bprompt_too_long\b|\bmaximum[ _-]+context[ _-]+(?:length|window)\b|\bmaximum[ _-]+input[ _-]+tokens\b|\binput[ _-]+length[ _-]+exceeds?\b|\b\d+[ _]+tokens?[ _]+>[ _]+\d+[ _]+maximum\b|\breduce(?:[ _]+the)?[ _]+(?:length|total)[ _]+of[ _]+(?:the[ _]+)?messages\b)/i;

export interface ContextOverflowProbeInput {
  errorMessage?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  /**
   * Free-form structured error messages extracted from the adapter's parsed
   * result payload (e.g. Anthropic `errors[].message` / OpenAI `error.message`).
   * Joined into the haystack the same way adapter-specific transient probes do.
   */
  parsedErrorMessages?: string[] | null;
}

export function isContextOverflowError(input: ContextOverflowProbeInput): boolean {
  const haystack = [
    input.errorMessage ?? "",
    ...(input.parsedErrorMessages ?? []),
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (!haystack) return false;
  return CONTEXT_OVERFLOW_ERROR_RE.test(haystack);
}
