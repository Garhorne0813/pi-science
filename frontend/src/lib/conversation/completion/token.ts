/** The span the caret sits inside: back to the previous whitespace, forward to the next one.
 *  A completion replaces the whole token, so a caret in the middle of a word replaces the tail
 *  instead of leaving it behind. */
export function tokenBounds(value: string, caret: number): { start: number; end: number } {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return { start, end };
}
