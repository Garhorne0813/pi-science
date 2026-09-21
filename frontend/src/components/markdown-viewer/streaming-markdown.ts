export type MarkdownRenderMode = "streaming" | "final";

type Fence = {
  marker: "`" | "~";
  length: number;
  offset: number;
};

type FenceLine = {
  marker: "`" | "~";
  length: number;
  offset: number;
  rest: string;
};

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

/** Return the source offset of the fence for the currently unclosed code block. */
export function findUnclosedFenceOffset(markdown: string): number | null {
  const state: { open: Fence | null } = { open: null };
  visitLines(markdown, (line, offset) => {
    const fence = parseFenceLine(line, offset);
    if (!fence) return;
    if (!state.open) {
      if (fence.marker === "`" && fence.rest.includes("`")) return;
      state.open = { marker: fence.marker, length: fence.length, offset: fence.offset };
      return;
    }
    if (
      fence.marker === state.open.marker
      && fence.length >= state.open.length
      && /^[ \t]*$/.test(fence.rest)
    ) {
      state.open = null;
    }
  });
  return state.open?.offset ?? null;
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
  let fence: Fence | null = null;
  let inlineTicks = 0;

  visitLines(markdown, (line, lineOffset) => {
    if (inlineTicks === 0) {
      const delimiter = parseFenceLine(line, lineOffset);
      if (delimiter) {
        if (!fence) {
          if (delimiter.marker !== "`" || !delimiter.rest.includes("`")) {
            fence = { marker: delimiter.marker, length: delimiter.length, offset: delimiter.offset };
            return;
          }
        } else if (
          delimiter.marker === fence.marker
          && delimiter.length >= fence.length
          && /^[ \t]*$/.test(delimiter.rest)
        ) {
          fence = null;
          return;
        }
      }
    }
    if (fence) return;

    for (let index = 0; index < line.length;) {
      const char = line[index]!;
      if (char === "`") {
        const length = runLength(line, index, "`");
        inlineTicks = inlineTicks === 0 ? length : inlineTicks === length ? 0 : inlineTicks;
        index += length;
        continue;
      }
      if (inlineTicks === 0 && char === "$" && !isEscaped(line, index)) {
        const double = line[index + 1] === "$";
        visit(double ? "$$" : "$", lineOffset + index);
        index += double ? 2 : 1;
        continue;
      }
      index += 1;
    }
  });
}

function parseFenceLine(line: string, lineOffset: number): FenceLine | null {
  // Blockquote markers are part of the container, not fence indentation.
  // Up to three spaces are allowed before the fence within that container.
  const match = /^((?:(?: {0,3}>[ \t]?)+)? {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const run = match[2]!;
  return {
    marker: run[0] as "`" | "~",
    length: run.length,
    offset: lineOffset + match[1]!.length,
    rest: match[3]!,
  };
}

function visitLines(markdown: string, visit: (line: string, offset: number) => void): void {
  let offset = 0;
  while (offset <= markdown.length) {
    const end = markdown.indexOf("\n", offset);
    if (end < 0) {
      visit(markdown.slice(offset), offset);
      return;
    }
    visit(markdown.slice(offset, end), offset);
    offset = end + 1;
  }
}

function runLength(value: string, start: number, marker: string): number {
  let end = start;
  while (value[end] === marker) end += 1;
  return end - start;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}
