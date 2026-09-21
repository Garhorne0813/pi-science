import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { collectCodeRanges, containerContinuationPrefix, type MarkdownSourceRange } from "./markdown-code-ranges";

export type MarkdownRenderMode = "streaming" | "final";

export type PreparedStreamingMarkdown = {
  text: string;
  codeRanges: MarkdownSourceRange[];
};

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const mathParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();
const MATH_PROBE = "PISCIENCE_MATH_PROBE";
const CONTAINER_PREFIX = /^[ \t>]*$/;

/**
 * Add presentation-only closing delimiters to an in-flight Markdown buffer.
 * The source value is never changed, and final mode bypasses this adapter.
 *
 * Fenced code that already closed (explicitly or through a container
 * boundary) is left alone. An unmatched backtick run inside the last
 * paragraph gets a synthetic closer, so math delimiters typed inside a
 * pending code span do not flash as KaTeX before the real closer arrives.
 */
export function stabilizeStreamingMarkdown(markdown: string): string {
  return prepareStreamingMarkdown(markdown).text;
}

/** Stabilize the buffer and report code ranges for the same output text. */
export function prepareStreamingMarkdown(markdown: string): PreparedStreamingMarkdown {
  const tree = mathParser.parse(markdown) as MarkdownNode;
  const codeRanges: MarkdownSourceRange[] = [];
  collectCodeRanges(tree, codeRanges);
  codeRanges.sort((a, b) => a.start - b.start);
  const span = findOpenCodeSpan(markdown, tree, codeRanges);
  if (span) {
    const closer = "`".repeat(span.length);
    return {
      text: `${markdown}${closer}`,
      codeRanges: [...codeRanges, { start: span.start, end: markdown.length + closer.length }],
    };
  }
  const math = findOpenDisplayMath(markdown, tree);
  if (!math) return { text: markdown, codeRanges };
  const closer = "$".repeat(math.openerLength);
  return {
    text: `${markdown}${markdown.endsWith("\n") ? "" : "\n"}${math.closingPrefix}${closer}`,
    codeRanges,
  };
}

type BacktickRun = { start: number; length: number };

function findOpenCodeSpan(
  markdown: string,
  tree: MarkdownNode,
  codeRanges: MarkdownSourceRange[],
): BacktickRun | null {
  // Appending at the end only closes a span when the closer stays a separate
  // run; a trailing backtick or escape would merge with or escape it.
  if (markdown.endsWith("`") || hasTrailingEscape(markdown)) return null;
  const host = lastInlineHost(tree);
  if (!host) return null;
  const afterHost = markdown.slice(host.end);
  // Paragraphs continue through a final newline; headings and table cells do
  // not, so their spans can only close on the very same line.
  const canContinue = host.type === "paragraph" ? /^[ \t]*\r?\n?$/.test(afterHost) : afterHost === "";
  if (!canContinue) return null;

  const runs: BacktickRun[] = [];
  for (let index = host.start; index < host.end; ) {
    const excluded = codeRanges.find((range) => index >= range.start && index < range.end);
    if (excluded) {
      index = excluded.end;
      continue;
    }
    if (markdown[index] !== "`") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < host.end && markdown[end] === "`") end += 1;
    if (!isEscaped(markdown, index)) runs.push({ start: index, length: end - index });
    index = end;
  }

  // CommonMark matches a backtick run with the next run of the same length.
  let cursor = 0;
  while (cursor < runs.length) {
    const run = runs[cursor]!;
    let match = cursor + 1;
    while (match < runs.length && runs[match]!.length !== run.length) match += 1;
    if (match === runs.length) return run;
    cursor = match + 1;
  }
  return null;
}

function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && markdown[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function hasTrailingEscape(markdown: string): boolean {
  let backslashes = 0;
  for (let i = markdown.length - 1; i >= 0 && markdown[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

type InlineHost = { type: string; start: number; end: number };

/** The last block that holds inline content, so an open span can only live there. */
function lastInlineHost(tree: MarkdownNode): InlineHost | null {
  let node = tree.children?.at(-1);
  while (node) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
      return { type: node.type, start, end };
    }
    if (node.children?.length) {
      node = node.children.at(-1);
      continue;
    }
    return null;
  }
  return null;
}

function findOpenDisplayMath(
  markdown: string,
  tree: MarkdownNode,
): { openerLength: number; closingPrefix: string } | null {
  const candidate = lastMathNode(tree);
  const start = candidate?.position?.start.offset;
  const end = candidate?.position?.end.offset;
  if (!candidate || start === undefined || end === undefined || candidate.value === undefined) return null;
  // Content after the node means a container boundary already closed it.
  if (/[^\s]/.test(markdown.slice(end))) return null;
  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const continuation = containerContinuationPrefix(markdown.slice(lineStart, start));
  // The closing line must continue the same container. A trailing list marker
  // is blanked out, so `- $$` closes on an indented continuation line.
  if (!CONTAINER_PREFIX.test(continuation)) return null;
  const openerRun = /^\$+/.exec(markdown.slice(start))?.[0];
  if (!openerRun) return null;
  const probe = markdown.endsWith("\n")
    ? `${markdown}${continuation}${MATH_PROBE}`
    : `${markdown}\n${continuation}${MATH_PROBE}`;
  const after = findMathNodeAt(mathParser.parse(probe) as MarkdownNode, start);
  if (!after || after.value === undefined || after.value.length <= candidate.value.length) return null;
  return { openerLength: openerRun.length, closingPrefix: continuation };
}

function lastMathNode(node: MarkdownNode): MarkdownNode | null {
  if (node.type === "math") return node;
  let found: MarkdownNode | null = null;
  for (const child of node.children ?? []) {
    const candidate = lastMathNode(child);
    if (candidate) found = candidate;
  }
  return found;
}

function findMathNodeAt(node: MarkdownNode, start: number): MarkdownNode | null {
  if (node.type === "math" && node.position?.start.offset === start) return node;
  for (const child of node.children ?? []) {
    const found = findMathNodeAt(child, start);
    if (found) return found;
  }
  return null;
}
