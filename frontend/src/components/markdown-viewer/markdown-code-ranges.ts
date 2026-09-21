import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type MarkdownSourceRange = { start: number; end: number };

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();
let cachedMarkdown: string | null = null;
let cachedRanges: MarkdownSourceRange[] = [];

function collectCodeRanges(node: MarkdownNode, ranges: MarkdownSourceRange[]): void {
  if (node.type === "code" || node.type === "inlineCode") {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
    return;
  }
  for (const child of node.children ?? []) collectCodeRanges(child, ranges);
}

/** Source ranges that CommonMark parsed as fenced, indented, or inline code. */
export function markdownCodeRanges(markdown: string): MarkdownSourceRange[] {
  if (markdown === cachedMarkdown) return cachedRanges;
  const ranges: MarkdownSourceRange[] = [];
  collectCodeRanges(markdownParser.parse(markdown) as MarkdownNode, ranges);
  cachedMarkdown = markdown;
  cachedRanges = ranges.sort((a, b) => a.start - b.start);
  return cachedRanges;
}

/** Whether a fenced code AST node still reaches the end of the streaming input. */
export function isUnclosedFencedCodeBlock(markdown: string, start: number, end: number): boolean {
  // A containing block can implicitly close a fence before the stream ends.
  // In that case later non-whitespace source exists beyond this AST node and
  // the code block is stable even without an explicit closing delimiter.
  if (markdown.slice(end).trim() !== "") return false;

  const firstLineEnd = markdown.indexOf("\n", start);
  const openingLine = markdown.slice(start, firstLineEnd < 0 ? markdown.length : firstLineEnd);
  const opening = /^(`{3,}|~{3,})/.exec(openingLine);
  if (!opening) return false;

  const marker = opening[1]![0]!;
  const minimumLength = opening[1]!.length;
  const finalSourceOffset = Math.max(start, end - 1);
  const lastLineStart = markdown.lastIndexOf("\n", finalSourceOffset) + 1;
  const lastLine = markdown.slice(lastLineStart, end);
  const containerPrefix = "(?:(?: {0,3}>[ \\t]?)+)?[ \\t]*";
  const closing = new RegExp(`^${containerPrefix}${marker === "`" ? "`" : "~"}{${minimumLength},}[ \\t]*$`);
  return !closing.test(lastLine);
}
