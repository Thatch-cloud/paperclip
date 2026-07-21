/**
 * review-gate-roster.mjs
 *
 * Parser and validator for .github/paperclip-agents.txt roster entries.
 *
 * Roster format (one entry per line):
 *
 *   # Comments start with # and are ignored.
 *   bare-key                # full author + review capability (backward compatible)
 *   key  author-only        # may author PRs but must never be Reviewer-agent
 *
 * Whitespace within a line separates the key from its capability markers.
 * Keys are lowercased and matched case-insensitively.
 *
 * Used by both review-gate.yml (via dynamic import) and the unit tests.
 */

/**
 * Parse raw roster text into a Map of lowercase key -> capability descriptor.
 *
 * @param {string} raw — raw contents of .github/paperclip-agents.txt
 * @returns {Map<string, { authorOnly: boolean }>}
 */
export function parseRoster(raw) {
  const roster = new Map();
  for (const originalLine of raw.split('\n')) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;

    const tokens = line.split(/\s+/);
    const key = tokens[0].toLowerCase();
    if (!key) continue;

    const markers = tokens.slice(1).map((t) => t.toLowerCase());
    const authorOnly = markers.includes('author-only');

    roster.set(key, { authorOnly });
  }
  return roster;
}

/**
 * Check whether a key exists in the roster.
 *
 * @param {string} key — agent key (case-insensitive)
 * @param {Map<string, { authorOnly: boolean }>} roster
 * @returns {boolean}
 */
export function hasKey(key, roster) {
  return roster.has(key.toLowerCase());
}

/**
 * Check whether a key is author-only (may author but not review).
 * Returns false for keys not in the roster (those are caught by the
 * separate membership check).
 *
 * @param {string} key — agent key (case-insensitive)
 * @param {Map<string, { authorOnly: boolean }>} roster
 * @returns {boolean}
 */
export function isAuthorOnly(key, roster) {
  const entry = roster.get(key.toLowerCase());
  return Boolean(entry && entry.authorOnly);
}
