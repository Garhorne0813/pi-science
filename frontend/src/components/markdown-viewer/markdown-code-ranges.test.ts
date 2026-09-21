import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { isUnclosedFencedCodeBlock } from "./markdown-code-ranges";

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

type CodeNode = { start: number; end: number; value: string; fenced: boolean };

function lastCodeNode(markdown: string): CodeNode | null {
  let found: CodeNode | null = null;
  const visit = (node: any): void => {
    if (node.type === "code") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      const firstLineEnd = markdown.indexOf("\n", start);
      const opening = markdown.slice(start, firstLineEnd < 0 ? markdown.length : firstLineEnd);
      found = { start, end, value: node.value, fenced: /^(`{3,}|~{3,})/.test(opening) };
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(markdown));
  return found;
}

function unclosed(markdown: string): boolean {
  const node = lastCodeNode(markdown);
  if (!node) return false;
  return isUnclosedFencedCodeBlock(markdown, node.start, node.end, node.value);
}

describe("isUnclosedFencedCodeBlock", () => {
  it.each([
    ["root fence without closer", "```python\nprint(1)", true],
    ["root fence with closer", "```python\nprint(1)\n```", false],
    ["root fence with longer closer", "~~~python\nprint(1)\n~~~~", false],
    ["blockquote fence without closer", "> ```python\n> print(1)", true],
    ["blockquote fence with closer", "> ```python\n> print(1)\n> ```", false],
    ["nested blockquote fence without closer", "> > ```python\n> > print(1)", true],
    ["blockquote fence closed by a blank line", "> ```python\n> print(1)\n\n", false],
    ["list fence without closer", "- item\n  ```python\n  print(1)", true],
    ["list fence closed by indented closer", "- item\n  ```python\n  print(1)\n  ```", false],
    ["list same-line fence without closer", "- ```python\n  print(1)", true],
    ["list fence followed by outside text", "- item\n  ```python\n  print(1)\noutside", false],
    ["empty blockquote fence", "> ```python", true],
  ])("%s", (_name, markdown, expected) => {
    expect(unclosed(markdown as string)).toBe(expected);
  });

  it("treats a blockquote-prefixed line inside a root fence as code content", () => {
    expect(unclosed('```python\nprint("partial")\n> ```')).toBe(true);
  });

  it("treats a four-space indented line inside a root fence as code content", () => {
    expect(unclosed("```python\nprint(1)\n    ```")).toBe(true);
  });

  it("treats a shorter marker run inside a root fence as code content", () => {
    expect(unclosed("```python\nprint(1)\n``")).toBe(true);
  });

  it("does not report indented code as a fenced block", () => {
    expect(unclosed("before\n\n    indented code")).toBe(false);
  });

  it("keeps a repeated probe for different buffers independent", () => {
    const closed = "```python\nx\n```";
    const open = "```python\nx";
    expect(unclosed(open)).toBe(true);
    expect(unclosed(closed)).toBe(false);
    expect(unclosed(open)).toBe(true);
  });
});
