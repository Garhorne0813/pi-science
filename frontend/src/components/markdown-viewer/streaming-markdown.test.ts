import { describe, expect, it } from "vitest";
import { stabilizeStreamingMarkdown } from "./streaming-markdown";

describe("stabilizeStreamingMarkdown", () => {
  it.each([
    ["incomplete emphasis", "**bold", "**bold"],
    ["fenced code", "```python\ndef fit(", "```python\ndef fit(\n```"],
    ["tilde fence", "~~~~r\nx <- 1", "~~~~r\nx <- 1\n~~~~"],
    ["display math", "$$\nE_a = 54.2", "$$\nE_a = 54.2\n$$"],
    ["inline math", "Energy is $E_a = 54.2", "Energy is $E_a = 54.2$"],
    ["currency", "Cost is $50", "Cost is $50"],
    ["shell variable", "Use $HOME", "Use $HOME"],
    ["partial table", "| A | B |\n| --- | ---\n| 1", "| A | B |\n| --- | ---\n| 1"],
  ])("stabilizes %s without changing the source semantics", (_name, input, expected) => {
    expect(stabilizeStreamingMarkdown(input)).toBe(expected);
  });

  it("does not interpret math delimiters inside an open code fence", () => {
    expect(stabilizeStreamingMarkdown("```python\nprice = '$$'"))
      .toBe("```python\nprice = '$$'\n```");
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
