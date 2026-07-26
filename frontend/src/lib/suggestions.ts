const SUGGEST_PATTERN = /<!--\s*suggest:\s*([\s\S]*?)-->/gi;
const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_LENGTH = 120;

/**
 * Extract follow-up questions from the trailing `<!--suggest: q1 | q2 | q3-->`
 * convention. Suggestions come from the last such comment; the clean text has
 * every suggest comment stripped so copy actions never expose the raw marker.
 */
export function parseSuggestions(text: string): { clean: string; suggestions: string[] } {
  const matches = [...text.matchAll(SUGGEST_PATTERN)];
  if (matches.length === 0) return { clean: text, suggestions: [] };
  const suggestions = matches[matches.length - 1][1]
    .split("|")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_SUGGESTION_LENGTH)
    .slice(0, MAX_SUGGESTIONS);
  return { clean: text.replace(SUGGEST_PATTERN, "").trimEnd(), suggestions };
}
