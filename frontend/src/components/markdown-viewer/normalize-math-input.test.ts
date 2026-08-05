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
    // No whitespace before the brace: not a stray brace.
    expect(stripStrayClosingBrace("x = \\right\\}")).toBe("x = \\right\\}");
    // The brace belongs to the formula (no space before it).
    expect(stripStrayClosingBrace("\\{a\\}")).toBe("\\{a\\}");
  });

  it("returns input unchanged when it does not end with a brace", () => {
    expect(stripStrayClosingBrace("E = mc^2")).toBe("E = mc^2");
    expect(stripStrayClosingBrace("a + b")).toBe("a + b");
  });
});

describe("normalizeMathInput", () => {
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
    // Formulas inside a sentence are already rendered by remark-math without
    // data loss; expanding them used to corrupt the surrounding text.
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

  it("never rewrites TeX inside an inline code span", () => {
    const input = "Use `$$x$$` literally.";
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
    // Literal private-use-area sequences without the module salt must survive
    // both directions (protect + restore) byte-identically.
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
