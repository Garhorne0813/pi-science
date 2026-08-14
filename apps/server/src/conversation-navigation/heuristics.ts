/** Keyword heuristic for automatic bookmark proposals (the "bookmarker"
 *  background role). Proposals only — nothing produced here is auto-accepted.
 *
 *  CJK keywords are matched as substrings: ASCII \b never fires between CJK
 *  characters, so a word-boundary regex can never match Chinese text. English
 *  keywords keep \b bounds so "resulted" / "saved-data" do not over-match.
 *  Deterministic: no randomness, and the last two matching messages win. */

const ENGLISH_BOOKMARK_TERMS = /\b(result|conclusion|finding|decision|saved|created|verified|completed)\b/i;
const CHINESE_BOOKMARK_TERMS = ["结果", "结论", "决定", "已保存", "已生成"];

export interface BookmarkCandidateMessage {
  id: string;
  content: Array<{ type?: string; text?: string }>;
}

/** Deterministically select candidate message ids worth bookmarking. */
export function proposeCandidates(messages: readonly BookmarkCandidateMessage[]): string[] {
  return messages
    .filter((message) => message.content.some((part) => {
      const text = part.text;
      if (typeof text !== "string") return false;
      if (ENGLISH_BOOKMARK_TERMS.test(text)) return true;
      return CHINESE_BOOKMARK_TERMS.some((term) => text.includes(term));
    }))
    .slice(-2)
    .map((message) => message.id);
}
