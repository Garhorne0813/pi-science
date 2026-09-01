import { describe, expect, it } from "vitest";
import { normalizeMathInput, stripStrayClosingBrace } from "./MarkdownViewer";

describe("stripStrayClosingBrace", () => {
  it("strips a stray closing brace after a balanced construct", () => {
    expect(stripStrayClosingBrace("x = \\right\\} }")).toBe("x = \\right\\}");
    expect(stripStrayClosingBrace("\\frac{a}{b} ] }")).toBe("\\frac{a}{b} ]");
    expect(stripStrayClosingBrace("(x+y) }")).toBe("(x+y)");
  });

  it("strips a stray closing brace inside a multi-line formula", () => {
    expect(stripStrayClosingBrace("\n\\left( x \\right) }\n")).toBe("\n\\left( x \\right)");
    expect(stripStrayClosingBrace("\n\\left( x \\right) }\n\n")).toBe("\n\\left( x \\right)");
  });

  it("keeps a legitimate trailing brace intact", () => {
    expect(stripStrayClosingBrace("x = \\right\\}")).toBe("x = \\right\\}");
    expect(stripStrayClosingBrace("\\{a\\}")).toBe("\\{a\\}");
  });

  it("returns input unchanged when it does not end with a brace", () => {
    expect(stripStrayClosingBrace("E = mc^2")).toBe("E = mc^2");
    expect(stripStrayClosingBrace("a + b")).toBe("a + b");
  });
});

describe("normalizeMathInput", () => {
  it("converts standalone bracket and parenthesis TeX delimiters", () => {
    expect(normalizeMathInput("\\[\nE = mc^2\n\\]")).toBe("$$\nE = mc^2\n$$");
    expect(normalizeMathInput("Energy \\(E = mc^2\\).")).toBe("Energy $E = mc^2$.");
  });

  it("keeps bracket display delimiters inside prose, blockquotes, and lists structurally intact", () => {
    expect(normalizeMathInput("Result: \\[x^2\\] here")).toBe("Result: \\[x^2\\] here");
    expect(normalizeMathInput("> \\[x^2\\]")).toBe("> \\[x^2\\]");
    expect(normalizeMathInput("- \\[x^2\\]")).toBe("- \\[x^2\\]");
    expect(normalizeMathInput("1. \\[x^2\\]")).toBe("1. \\[x^2\\]");
  });

  it("converts a standalone single-line bracket display", () => {
    expect(normalizeMathInput("before\n\n\\[x^2\\]\n\nafter")).toBe("before\n\n$$\nx^2\n$$\n\nafter");
  });

  it("expands a single-line display formula to the block form", () => {
    expect(normalizeMathInput("$$x^2$$")).toBe("$$\nx^2\n$$");
  });

  it("keeps a multi-line display formula untouched", () => {
    const input = "$$\n\\frac{a}{b} = c\n$$";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("strips a stray closing brace inside a single-line formula", () => {
    expect(normalizeMathInput("$$\\sin(x) \\right\\} }$$")).toBe("$$\n\\sin(x) \\right\\}\n$$");
  });

  it("keeps inline formulas untouched (no sentence corruption)", () => {
    expect(normalizeMathInput("A $$x_1$$ and B $$x_2$$")).toBe("A $$x_1$$ and B $$x_2$$");
  });

  it("keeps a line-leading formula with trailing text untouched", () => {
    expect(normalizeMathInput("$$x^2$$ then more text")).toBe("$$x^2$$ then more text");
  });

  it("keeps formulas inside blockquote and list lines untouched", () => {
    expect(normalizeMathInput("> $$x^2$$")).toBe("> $$x^2$$");
    expect(normalizeMathInput("- $$x^2$$")).toBe("- $$x^2$$");
    expect(normalizeMathInput("1. $$x^2$$")).toBe("1. $$x^2$$");
  });

  it("expands a standalone formula line within a document", () => {
    expect(normalizeMathInput("text before\n\n$$y = mx$$\n\ntext after")).toBe(
      "text before\n\n$$\ny = mx\n$$\n\ntext after",
    );
  });

  it("fixes multiple standalone formulas in one document", () => {
    const result = normalizeMathInput("$$x_1$$\n\n$$x_2$$");
    expect(result).toBe("$$\nx_1\n$$\n\n$$\nx_2\n$$");
  });

  it("never rewrites TeX inside a fenced code block", () => {
    const input = "```\n$$\\text{example}$$ $x$\n```";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("never rewrites TeX inside a tilde-fenced code block", () => {
    const input = "~~~\n$$\n\\frac{a}{b}\n$$\n~~~";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("never rewrites TeX inside an indented CommonMark code block", () => {
    const input = "before\n\n    const s = \\\"\\\\(x\\\\)\\\";\n    const display = \\\"\\\\[y\\\\]\\\";\n\nafter";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("never rewrites TeX inside a tab-indented CommonMark code block", () => {
    const input = "\tconst s = \\\"\\\\(x\\\\)\\\";";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("preserves the newline after indented code so adjacent display math still normalizes", () => {
    expect(normalizeMathInput("    code\n$$x^2$$")).toBe("    code\n$$\nx^2\n$$");
    expect(normalizeMathInput("    code\n\\[x^2\\]")).toBe("    code\n$$\nx^2\n$$");
  });

  it("normalizes math in a four-space list continuation instead of treating it as top-level code", () => {
    expect(normalizeMathInput("- item\n    \\(x\\)")).toBe("- item\n    $x$");
  });

  it("never rewrites TeX inside an inline code span", () => {
    const input = "Use `$$x$$`, `\\[y\\]`, and `\\(z\\)` literally.";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("never rewrites TeX inside an even-run backtick code span", () => {
    const input = "Use ``$$x^2$$`` literally.";
    expect(normalizeMathInput(input)).toBe(input);
    const mixed = "A ``$$x$$`` and `$$y$$` and ``z``";
    expect(normalizeMathInput(mixed)).toBe(mixed);
  });

  it("never rewrites TeX inside a code span containing a backtick", () => {
    const input = "Use `a`b`c`? No — ``a`b`` with even runs.";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("keeps a display formula with a legitimate trailing brace", () => {
    expect(normalizeMathInput("$$x = \\left\\{ a \\right\\}$$")).toBe(
      "$$\nx = \\left\\{ a \\right\\}\n$$",
    );
  });

  it("leaves plain text and single-dollar amounts untouched", () => {
    const input = "Cost $5 and $10, no display math here.";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("leaves user text that resembles a placeholder untouched", () => {
    const input = "before \uE0000\uE001 after";
    expect(normalizeMathInput(input)).toBe(input);
  });

  it("mixes math and protected code in one document", () => {
    const input = "Formula\n\n$$y = mx$$\n\nand code `$$z$$` and fence\n```\n$$w$$\n```";
    const result = normalizeMathInput(input);
    expect(result).toContain("$$\ny = mx\n$$");
    expect(result).toContain("`$$z$$`");
    expect(result).toContain("```\n$$w$$\n```");
  });
});
