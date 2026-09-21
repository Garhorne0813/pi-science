import { describe, expect, it } from "vitest";
import { normalizeMathInput } from "./MarkdownViewer";
import { markdownCodeRanges } from "./markdown-code-ranges";
import { prepareStreamingMarkdown, stabilizeStreamingMarkdown } from "./streaming-markdown";

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
    ["partial table", "| A | B |\n| --- |\n| 1", "| A | B |\n| --- |\n| 1"],
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

  it("ignores prose double dollars before an incomplete display block", () => {
    expect(stabilizeStreamingMarkdown("In bash, $$ is the PID.\n\n$$\nE = mc^2"))
      .toBe("In bash, $$ is the PID.\n\n$$\nE = mc^2\n$$");
  });

  it("does not close display math after its container has ended", () => {
    const blockquote = "> $$\n> x = 1\n\noutside";
    const list = "- equation\n  $$\n  x = 1\n\noutside";
    expect(stabilizeStreamingMarkdown(blockquote)).toBe(blockquote);
    expect(stabilizeStreamingMarkdown(list)).toBe(list);
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

  it.each([
    ["complete triple-dollar math", "$$$\nx\n$$$"],
    ["complete math with a longer closer", "$$\nx\n$$$"],
    ["complete math with a trailing newline", "$$$\nx\n$$$\n"],
    ["complete single-line math", "$$x$$"],
    ["complete math with a longer run", "$$x$$$"],
    ["complete quadruple-dollar math", "$$$$x$$$$"],
    ["complete multi-line quadruple-dollar math", "$$$$\nx\n$$$$"],
  ])("leaves %s byte-for-byte unchanged", (_name, complete) => {
    expect(stabilizeStreamingMarkdown(complete)).toBe(complete);
  });

  it.each([
    ["triple-dollar math", "$$$\nx", "$$$\nx\n$$$"],
    ["quadruple-dollar math", "$$$$\nx", "$$$$\nx\n$$$$"],
    ["short closer for a long opener", "$$$$\nx\n$$", "$$$$\nx\n$$\n$$$$"],
    ["empty math opener", "$$", "$$\n$$"],
  ])("closes unclosed %s with a matching run", (_name, input, expected) => {
    expect(stabilizeStreamingMarkdown(input)).toBe(expected);
  });

  it("does not close display math after a blockquote container ended", () => {
    const blockquote = "> $$\n> x = 1\n\n";
    expect(stabilizeStreamingMarkdown(blockquote)).toBe(blockquote);
  });

  it("closes display math inside a list item that can still continue", () => {
    expect(stabilizeStreamingMarkdown("- x\n  $$\n  y = 1\n\n"))
      .toBe("- x\n  $$\n  y = 1\n\n  $$");
  });

  it("closes display math on the line that opened it in a list item", () => {
    expect(stabilizeStreamingMarkdown("- $$\n  x")).toBe("- $$\n  x\n  $$");
    expect(stabilizeStreamingMarkdown("> - $$\n>   x")).toBe("> - $$\n>   x\n>   $$");
  });

  it.each([
    ["single backtick", 'Use `formula = "\\(x^2\\)"', 'Use `formula = "\\(x^2\\)"`'],
    ["inline dollars", "Use `$$x^2$$", "Use `$$x^2$$`"],
    ["double backticks", "Use ``\\(x\\)", "Use ``\\(x\\)``"],
    ["triple backticks", "Use ```\\(x\\)", "Use ```\\(x\\)```"],
  ])("closes an open inline code span: %s", (_name, input, expected) => {
    expect(stabilizeStreamingMarkdown(input)).toBe(expected);
  });

  it("keeps a multi-backtick closer on the paragraph line before the newline", () => {
    expect(stabilizeStreamingMarkdown("Use ```\\(x\\)\n")).toBe("Use ```\\(x\\)```\n");
    expect(stabilizeStreamingMarkdown("> Use ```\\(x\\)\n")).toBe("> Use ```\\(x\\)```\n");
    expect(stabilizeStreamingMarkdown("- item\n  Use ```\\(x\\)\n")).toBe("- item\n  Use ```\\(x\\)```\n");
  });

  it("does not close a backtick run that later deltas cannot continue", () => {
    expect(stabilizeStreamingMarkdown("Use `x\n\nmore")).toBe("Use `x\n\nmore");
    expect(stabilizeStreamingMarkdown("Use `")).toBe("Use `");
    expect(stabilizeStreamingMarkdown("Use \\` literal")).toBe("Use \\` literal");
    expect(stabilizeStreamingMarkdown("# Heading `x\n")).toBe("# Heading `x\n");
    expect(stabilizeStreamingMarkdown("Use `\n")).toBe("Use `\n");
    expect(stabilizeStreamingMarkdown("Use `x\\\n")).toBe("Use `x\\\n");
  });

  it("reports the synthetic code span range for the stabilized text", () => {
    const prepared = prepareStreamingMarkdown("Use `\\(x\\)");
    expect(prepared.text).toBe("Use `\\(x\\)`");
    expect(prepared.codeRanges).toEqual([{ start: 4, end: prepared.text.length }]);
  });

  it("handles a 10k-character streaming buffer without truncation", () => {
    const input = `${"科研结果。".repeat(2_000)}\n\n$$\nE = mc^2`;
    const output = stabilizeStreamingMarkdown(input);
    expect(output.startsWith(input)).toBe(true);
    expect(output.length).toBe(input.length + 3);
  });

  it("reports code ranges that match a fresh parse of the stabilized text", () => {
    const inputs = [
      "Use `\\(x\\)",
      "Use `$$x^2$$",
      "```python\nprice = '$$'",
      "```python\nprint(1)\n```\n\ntext",
      "- item\n  ```python\n  x = 1",
      "Use ``a`b`` and `open",
      "Use `open and ``closed`` tail",
      "Use `open and ``closed`` tail\n",
      "`a ``b`` c",
      "$$\nx\n\nUse `open",
    ];
    for (const input of inputs) {
      const prepared = prepareStreamingMarkdown(input);
      if (prepared.text === input) {
        expect(prepared.codeRanges, input).toBeUndefined();
      } else {
        expect(prepared.codeRanges, input).toEqual(markdownCodeRanges(prepared.text));
      }
    }
  });

  it("keeps the stabilized code ranges sorted and non-overlapping", () => {
    const prepared = prepareStreamingMarkdown("Use `open and ``closed`` tail");
    const ranges = prepared.codeRanges;
    expect(ranges).toBeDefined();
    for (let index = 1; index < ranges!.length; index += 1) {
      expect(ranges![index]!.start).toBeGreaterThanOrEqual(ranges![index - 1]!.end);
    }
    expect(ranges).toEqual([{ start: 4, end: prepared.text.length }]);
  });

  it("keeps range equivalence and the fixed point across generated buffers", () => {
    const parts = ["`", "``", "```", "$", "$$", "x", " ", "\n", "> ", "- ", "| ", "\\(", "\\)", "*", "1. "];
    let seed = 20240921;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      let input = "";
      const count = 1 + Math.floor(random() * 10);
      for (let part = 0; part < count; part += 1) input += parts[Math.floor(random() * parts.length)];
      const prepared = prepareStreamingMarkdown(input);
      if (prepared.text === input) {
        expect(prepared.codeRanges, input).toBeUndefined();
      } else {
        expect(prepared.codeRanges, input).toEqual(markdownCodeRanges(prepared.text));
      }
      expect(normalizeMathInput(prepared.text, prepared.codeRanges), input).toBe(normalizeMathInput(prepared.text));
      expect(prepareStreamingMarkdown(prepared.text).text, input).toBe(prepared.text);
    }
  });

  // Two full parses of a 100k buffer is the real streaming cost; slow CI
  // runners need more than the default 5s. The scan itself is O(N + ranges).
  it("prepares a 100k-character mixed buffer without truncation", { timeout: 15_000 }, () => {
    const line = "\u79d1\u7814\u7ed3\u679c **bold** `code` \\(x\\) and $E = mc^2$\n";
    const input = `${line.repeat(Math.ceil(100_000 / line.length))}\n$$\nE = mc^2`;
    const prepared = prepareStreamingMarkdown(input);
    expect(prepared.text.startsWith(input)).toBe(true);
    expect(prepared.text.endsWith("\n$$")).toBe(true);
  });

});
