import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type MarkdownRenderMode = "streaming" | "final";

/**
 * Add presentation-only closing delimiters to an in-flight Markdown buffer.
 * The source value is never changed, and final mode bypasses this adapter.
 *
 * Fenced code and inline math are deliberately left alone. CommonMark closes
 * an unterminated fence at the end of its containing block, while guessing at
 * a single-dollar delimiter can turn prices or shell variables into KaTeX.
 */
export function stabilizeStreamingMarkdown(markdown: string): string {
  return closeOpenDisplayMath(markdown);
}

function closeOpenDisplayMath(markdown: string): string {
  const open = findOpenDisplayMath(markdown);
  if (!open) return markdown;
  const closingPrefix = displayMathPrefix(markdown, open.start);
  if (closingPrefix === null) return markdown;
  return `${markdown}${markdown.endsWith("\n") ? "" : "\n"}${closingPrefix}$$`;
}

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const mathParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

function findOpenDisplayMath(markdown: string): { start: number; end: number } | null {
  const candidates: Array<{ start: number; end: number }> = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "math") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) candidates.push({ start, end });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(mathParser.parse(markdown) as MarkdownNode);
  const candidate = candidates.at(-1);
  if (!candidate || markdown.slice(candidate.end).trim() !== "") return null;

  const lastLineStart = markdown.lastIndexOf("\n", Math.max(candidate.start, candidate.end - 1)) + 1;
  const lastLine = markdown.slice(lastLineStart, candidate.end);
  const explicitClose = /^(?:(?: {0,3}>[ \t]?)+)?[ \t]*\$\$[ \t]*$/.test(lastLine);
  return explicitClose ? null : candidate;
}

function displayMathPrefix(markdown: string, offset: number): string | null {
  const lineStart = markdown.lastIndexOf("\n", offset - 1) + 1;
  const prefix = markdown.slice(lineStart, offset);
  // Only synthesize a close for a block delimiter. Preserve blockquote and
  // list indentation so the close remains inside the same Markdown container.
  return /^(?:(?: {0,3}>[ \t]?)+)?[ \t]*$/.test(prefix) ? prefix : null;
}
