const SUGGEST_PATTERN = /<!--\s*suggest:\s*([\s\S]*?)-->/gi;
const NESTED_SUGGEST_PATTERN = /<!--\s*suggest:\s*/gi;
const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_LENGTH = 120;

function suggestionKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[。.!！?？]+$/u, "")
    .trim();
}

/**
 * Extract follow-up questions from the trailing `<!--suggest: q1 | q2 | q3-->`
 * convention. Suggestions come from the last such comment; the clean text has
 * every suggest comment stripped so copy actions never expose the raw marker.
 */
export function parseSuggestions(text: string): { clean: string; suggestions: string[] } {
  const matches = [...text.matchAll(SUGGEST_PATTERN)];
  if (matches.length === 0) return { clean: text, suggestions: [] };
  const seen = new Set<string>();
  const suggestions = matches[matches.length - 1][1]
    // Models occasionally repeat the protocol opener inside the same HTML
    // comment. Treat it as another separator instead of leaking the raw marker
    // into a suggestion chip.
    .replace(NESTED_SUGGEST_PATTERN, "|")
    .split("|")
    .map((item) => item.trim())
    .filter((item) => {
      if (item.length === 0 || item.length > MAX_SUGGESTION_LENGTH) return false;
      const key = suggestionKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SUGGESTIONS);
  return { clean: text.replace(SUGGEST_PATTERN, "").trimEnd(), suggestions };
}
