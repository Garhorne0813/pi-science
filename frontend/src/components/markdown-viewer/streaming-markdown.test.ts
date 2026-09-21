import { describe, expect, it } from "vitest";
import { stabilizeStreamingMarkdown } from "./streaming-markdown";

describe("stabilizeStreamingMarkdown", () => {
  it.each([
    ["incomplete emphasis", "**bold", "**bold"],
    ["fenced code", "```python\ndef fit(", "```python\ndef fit("],
    ["tilde fence", "~~~~r\nx <- 1", "~~~~r\nx <- 1"],
    ["display math", "$$\nE_a = 54.2", "$$\nE_a = 54.2\n$$"],
    ["inline math", "Energy is $E_a = 54.2", "Energy is $E_a = 54.2"],
    ["currency", "Cost is $50", "Cost is $50"],
    ["shell variable", "Use $HOME", "Use $HOME"],
    ["currency before equation-like prose", "Cost is $50, and x = 2", "Cost is $50, and x = 2"],
    ["shell variable before equation-like prose", "Use $HOME and set x = 2", "Use $HOME and set x = 2"],
    ["currency before incomplete math", "Cost is $50, equation $x = 2", "Cost is $50, equation $x = 2"],
    ["partial table", "| A | B |\n| --- | ---\n| 1", "| A | B |\n| --- | ---\n| 1"],
  ])("stabilizes %s without changing the source semantics", (_name, input, expected) => {
    expect(stabilizeStreamingMarkdown(input)).toBe(expected);
  });

  it("does not interpret math delimiters inside an open code fence", () => {
    expect(stabilizeStreamingMarkdown("```python\nprice = '$$'"))
      .toBe("```python\nprice = '$$'");
  });

  it("leaves list and blockquote fences for CommonMark to close in their containers", () => {
    expect(stabilizeStreamingMarkdown("- item\n  ```python\n  x = 1"))
      .toBe("- item\n  ```python\n  x = 1");
    expect(stabilizeStreamingMarkdown("> ```python\n> x = 1"))
      .toBe("> ```python\n> x = 1");
  });

  it("keeps display-math synthetic closures in their container", () => {
    expect(stabilizeStreamingMarkdown("- equation\n  $$\n  x = 1"))
      .toBe("- equation\n  $$\n  x = 1\n  $$");
    expect(stabilizeStreamingMarkdown("> $$\n> x = 1"))
      .toBe("> $$\n> x = 1\n> $$");
  });

  it("resumes display-math handling after an implicitly closed code container", () => {
    expect(stabilizeStreamingMarkdown("> ```python\n> done\n\n$$\nx = 1"))
      .toBe("> ```python\n> done\n\n$$\nx = 1\n$$");
  });

  it("ignores math delimiters inside code spans with any backtick length", () => {
    expect(stabilizeStreamingMarkdown("Use ```$HOME=x``` then\n\n$$\ny = 2"))
      .toBe("Use ```$HOME=x``` then\n\n$$\ny = 2\n$$");
  });

  it("leaves complete Markdown byte-for-byte unchanged", () => {
    const complete = "中文 $E = mc^2$\n\n```python\nprint(1)\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(stabilizeStreamingMarkdown(complete)).toBe(complete);
  });

  it("handles a 10k-character streaming buffer without truncation", () => {
    const input = `${"科研结果。".repeat(2_000)}\n\n$$\nE = mc^2`;
    const output = stabilizeStreamingMarkdown(input);
    expect(output.startsWith(input)).toBe(true);
    expect(output.length).toBe(input.length + 3);
  });
});
