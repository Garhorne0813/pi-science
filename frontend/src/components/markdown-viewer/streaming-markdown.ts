import { markdownCodeRanges } from "./markdown-code-ranges";

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
  let open = false;
  let closingPrefix: string | null = null;
  visitOutsideCode(markdown, (token, offset) => {
    if (token !== "$$") return;
    open = !open;
    closingPrefix = open ? displayMathPrefix(markdown, offset) : null;
  });
  if (!open || closingPrefix === null) return markdown;
  return `${markdown}${markdown.endsWith("\n") ? "" : "\n"}${closingPrefix}$$`;
}

function displayMathPrefix(markdown: string, offset: number): string | null {
  const lineStart = markdown.lastIndexOf("\n", offset - 1) + 1;
  const prefix = markdown.slice(lineStart, offset);
  // Only synthesize a close for a block delimiter. Preserve blockquote and
  // list indentation so the close remains inside the same Markdown container.
  return /^(?:(?: {0,3}>[ \t]?)+)?[ \t]*$/.test(prefix) ? prefix : null;
}

function visitOutsideCode(markdown: string, visit: (token: "$" | "$$", offset: number) => void): void {
  const ranges = markdownCodeRanges(markdown);
  let rangeIndex = 0;

  for (let index = 0; index < markdown.length;) {
    const range = ranges[rangeIndex];
    if (range && index >= range.start) {
      index = Math.max(index, range.end);
      rangeIndex += 1;
      continue;
    }
    if (markdown[index] === "$" && !isEscaped(markdown, index)) {
      const double = markdown[index + 1] === "$";
      visit(double ? "$$" : "$", index);
      index += double ? 2 : 1;
      continue;
    }
    index += 1;
  }
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}
