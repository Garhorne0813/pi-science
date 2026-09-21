export type MarkdownRenderMode = "streaming" | "final";

/**
 * Add presentation-only closing delimiters to an in-flight Markdown buffer.
 * The source value is never changed, and final mode bypasses this adapter.
 */
export function stabilizeStreamingMarkdown(markdown: string): string {
  const fenced = closeOpenFence(markdown);
  const displayMath = closeOpenDisplayMath(fenced);
  return closeLikelyInlineMath(displayMath);
}

function closeOpenFence(markdown: string): string {
  let open: { marker: "`" | "~"; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const fence = match[1]!;
    const marker = fence[0] as "`" | "~";
    if (!open) {
      open = { marker, length: fence.length };
      continue;
    }
    if (marker === open.marker && fence.length >= open.length && new RegExp(`^ {0,3}${escapeRegExp(marker)}{${open.length},}[ \\t]*$`).test(line)) open = null;
  }
  if (!open) return markdown;
  return `${markdown}${markdown.endsWith("\n") ? "" : "\n"}${open.marker.repeat(open.length)}`;
}

function closeOpenDisplayMath(markdown: string): string {
  let open = false;
  visitOutsideCode(markdown, (token) => {
    if (token === "$$") open = !open;
  });
  return open ? `${markdown}${markdown.endsWith("\n") ? "" : "\n"}$$` : markdown;
}

function closeLikelyInlineMath(markdown: string): string {
  let openAt = -1;
  visitOutsideCode(markdown, (token, offset) => {
    if (token !== "$") return;
    openAt = openAt < 0 ? offset : -1;
  });
  if (openAt < 0) return markdown;
  const candidate = markdown.slice(openAt + 1);
  // Avoid turning prices and shell variables into math merely because their
  // closing delimiter has not arrived. Once mathematical syntax is visible,
  // a synthetic close keeps the partial expression in a stable KaTeX region.
  return /[\\^_={}]|\b(?:frac|sqrt|sum|int|alpha|beta|gamma)\b/.test(candidate)
    ? `${markdown}$`
    : markdown;
}

function visitOutsideCode(markdown: string, visit: (token: "$" | "$$", offset: number) => void): void {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inlineTicks = 0;
  let lineStart = true;
  for (let index = 0; index < markdown.length;) {
    const char = markdown[index]!;
    if (lineStart && inlineTicks === 0) {
      const line = markdown.slice(index, markdown.indexOf("\n", index) < 0 ? markdown.length : markdown.indexOf("\n", index));
      const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        const run = match[1]!;
        const marker = run[0] as "`" | "~";
        if (!fence) fence = { marker, length: run.length };
        else if (marker === fence.marker && run.length >= fence.length && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) fence = null;
      }
    }
    if (!fence && char === "`") {
      const length = runLength(markdown, index, "`");
      if (length < 3) inlineTicks = inlineTicks === 0 ? length : inlineTicks === length ? 0 : inlineTicks;
      index += length;
      lineStart = false;
      continue;
    }
    if (!fence && inlineTicks === 0 && char === "$" && !isEscaped(markdown, index)) {
      const double = markdown[index + 1] === "$";
      visit(double ? "$$" : "$", index);
      index += double ? 2 : 1;
      lineStart = false;
      continue;
    }
    lineStart = char === "\n";
    index += 1;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
