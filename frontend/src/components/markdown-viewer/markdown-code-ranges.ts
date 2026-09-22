import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type MarkdownSourceRange = { start: number; end: number };

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const markdownParser = unified().use(remarkParse).use(remarkGfm).freeze();
let cachedMarkdown: string | null = null;
let cachedRanges: MarkdownSourceRange[] = [];

export function collectCodeRanges(node: MarkdownNode, ranges: MarkdownSourceRange[]): void {
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

/**
 * The prefix that continues a fence or flow-math container on the next line.
 * A trailing list marker becomes spaces of the same width, so a probe line
 * continues `- ``` ` as an item line instead of opening a second item.
 */
export function containerContinuationPrefix(prefix: string): string {
  let column = 0;
  let expanded = "";
  for (const character of prefix) {
    if (character === "\t") {
      const width = 4 - (column % 4);
      expanded += " ".repeat(width);
      column += width;
    } else {
      expanded += character;
      column += 1;
    }
  }
  let current = expanded;
  while (true) {
    const next = current.replace(/(^|[ \t>])(?:[-*+]|\d{1,9}[.)])(?=[ \t]+)/g, (match: string, lead: string) =>
      lead + " ".repeat(match.length - lead.length),
    );
    if (next === current) return next;
    current = next;
  }
}

const FENCE_PROBE = "PISCIENCE_FENCE_PROBE";
const FENCE_OPENING = /^(`{3,}|~{3,})/;
const CONTINUATION_PREFIX = /^[ \t>]*$/;

let probeCache: { markdown: string; start: number; open: boolean } | null = null;

/**
 * Whether a fenced code AST node can still receive more content from future
 * streaming deltas. The parser is the authority: append a continuation line
 * and check whether the code value grows. A container that already ended
 * (blank line in a blockquote, missing list indentation) does not grow, and a
 * closing fence was already excluded from the parsed value.
 */
export function isUnclosedFencedCodeBlock(
  markdown: string,
  start: number,
  end: number,
  code: string,
  lastNonWhitespaceOffset = markdown.trimEnd().length,
): boolean {
  // A single scan per rendered document is enough; do not rescan a suffix for every <pre>.
  if (end < lastNonWhitespaceOffset) return false;
  if (probeCache && probeCache.markdown === markdown && probeCache.start === start) return probeCache.open;
  const open = probeFenceOpen(markdown, start, code);
  probeCache = { markdown, start, open };
  return open;
}

function probeFenceOpen(markdown: string, start: number, code: string): boolean {
  const firstLineEnd = markdown.indexOf("\n", start);
  const openingLine = markdown.slice(start, firstLineEnd < 0 ? markdown.length : firstLineEnd);
  if (!FENCE_OPENING.test(openingLine)) return false;
  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const openerPrefix = markdown.slice(lineStart, start);
  const continuation = containerContinuationPrefix(openerPrefix);
  // The probe line must continue the fence's container, not start a new block.
  if (!CONTINUATION_PREFIX.test(continuation)) return false;
  const probe = markdown.endsWith("\n")
    ? `${markdown}${continuation}${FENCE_PROBE}`
    : `${markdown}\n${continuation}${FENCE_PROBE}`;
  const node = findCodeNodeAt(markdownParser.parse(probe) as MarkdownNode, start);
  return node?.value !== undefined && node.value.length > code.length;
}

function findCodeNodeAt(node: MarkdownNode, start: number): MarkdownNode | null {
  if (node.type === "code" && node.position?.start.offset === start) return node;
  for (const child of node.children ?? []) {
    const found = findCodeNodeAt(child, start);
    if (found) return found;
  }
  return null;
}
