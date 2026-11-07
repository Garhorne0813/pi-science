/** The sentence a body marker sits in.
 *
 *  A passage lookup needs the claim, not the whole answer: the same paper is
 *  cited by different sentences and each sentence points at different text.
 *  The answer is rendered Markdown, so the marker's own position is read back
 *  from the DOM rather than from the source text, which the renderer has
 *  already rewritten (links, emphasis, numbers).
 */

/** Elements whose text is one readable unit. A marker inside a table cell
 *  belongs to the cell's text, not to the whole table. */
const CLAIM_CONTAINER = "p, li, td, th, blockquote, dd, dt, figcaption, h1, h2, h3, h4, h5, h6";

/** Sentence-final punctuation. The CJK forms are separate characters, not
 *  ranges, because each one ends a sentence on its own. */
const TERMINATORS = "。！？；…";
const ASCII_TERMINATORS = ".!?;";
/** Longest claim a lookup will send. A paragraph without a full stop still has
 *  to be bounded, and the server rejects anything past this anyway. */
export const MAX_CLAIM_CHARS = 600;

function isTerminator(text: string, at: number): boolean {
  const char = text[at]!;
  if (TERMINATORS.includes(char)) return true;
  if (!ASCII_TERMINATORS.includes(char)) return false;
  // `10.1000/a` and `e.g.` are not sentence ends: an ASCII terminator only
  // counts when a space or the end of the text follows it.
  const next = text[at + 1];
  return next === undefined || next === " " || next === "\n";
}

/** Where a claim may stop: the offset one past a sentence end, or the offset
 *  where a blank line starts. Sorted ascending, which is what the two searches
 *  below rely on. */
function boundaries(text: string): number[] {
  const found: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    if (isTerminator(text, at)) { found.push(at + 1); continue; }
    if (text[at] === "\n" && text[at + 1] === "\n") { found.push(at); at += 1; }
  }
  return found;
}

/** The sentence around `offset`, trimmed, with a hard cap. An offset past the
 *  text clamps to its last character instead of throwing: the caller measured
 *  it in a DOM that the answer may have re-rendered since. */
export function claimAround(text: string, offset: number, max = MAX_CLAIM_CHARS): string {
  if (!text.length) return "";
  const at = Math.max(0, Math.min(offset, text.length - 1));
  const stops = boundaries(text);
  let start = 0;
  let end = text.length;
  for (const stop of stops) {
    if (stop <= at) start = stop;
    else { end = stop; break; }
  }
  const sentence = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (sentence.length <= max) return sentence;
  // A long sentence keeps the marker's own neighbourhood, so the claim never
  // loses the words the citation is actually attached to.
  const room = Math.floor((max - 1) / 2);
  const from = Math.max(0, Math.min(at - start - room, sentence.length - max));
  return sentence.slice(from, from + max - 1).trim() + "…";
}

/** Where `node` begins inside `container`'s text, or null when the node is not
 *  inside it. Only the browser can answer this, so it lives beside the render
 *  and not in the numbering path. */
export function offsetOfNode(container: HTMLElement, node: Node): number | null {
  if (typeof document === "undefined") return null;
  const range = document.createRange();
  try {
    range.setStart(container, 0);
    range.setEnd(node, 0);
  } catch { return null; }
  return range.toString().length;
}

/** The claim for a body marker, measured from the element that holds it. */
export function claimForTrigger(trigger: HTMLElement | null): string {
  if (!trigger) return "";
  const container = trigger.closest(CLAIM_CONTAINER) as HTMLElement | null;
  if (!container) return "";
  const text = container.textContent ?? "";
  const offset = offsetOfNode(container, trigger);
  return claimAround(text, offset ?? text.length);
}
