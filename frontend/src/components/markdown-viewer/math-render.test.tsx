import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

/**
 * Rendering-level assertions for normalizeMathInput: these exercise the real
 * remark-math + rehype-katex pipeline (string-level tests alone gave false
 * confidence — the previous unconditional expansion passed string tests while
 * corrupting the rendered output).
 */
describe("MarkdownViewer math rendering (normalizeMathInput integration)", () => {
  it("renders an inline sentence formula without losing surrounding text", () => {
    const { container } = render(<MarkdownViewer>{"这里 $$E=mc^2$$ 是质能方程"}</MarkdownViewer>);
    expect(container.textContent).toContain("这里");
    expect(container.textContent).toContain("是质能方程");
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("keeps a line-leading formula with trailing text intact", () => {
    const { container } = render(<MarkdownViewer>{"$$x^2$$ then more text"}</MarkdownViewer>);
    expect(container.textContent).toContain("then more text");
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("renders math inside a blockquote without corruption", () => {
    const { container } = render(<MarkdownViewer>{"> $$x^2$$"}</MarkdownViewer>);
    expect(container.querySelector("blockquote")).toBeInTheDocument();
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("renders math inside a list item without corruption", () => {
    const { container } = render(<MarkdownViewer>{"- $$x^2$$"}</MarkdownViewer>);
    expect(container.querySelector("li")).toBeInTheDocument();
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("renders a standalone single-line formula as display math", () => {
    const { container } = render(<MarkdownViewer>{"$$x^2$$"}</MarkdownViewer>);
    expect(container.querySelector(".katex-display .katex")).toBeInTheDocument();
  });

  it("renders a multi-line formula with a stray closing brace", () => {
    const { container } = render(<MarkdownViewer>{"$$\n\\left( x \\right) }\n$$"}</MarkdownViewer>);
    expect(container.querySelector(".katex-display .katex")).toBeInTheDocument();
  });

  it("does not render math inside an even-run backtick code span", () => {
    const { container } = render(<MarkdownViewer>{"Use ``$$x^2$$`` literally"}</MarkdownViewer>);
    expect(container.textContent).toContain("$$x^2$$");
    expect(container.querySelector("code")).toBeInTheDocument();
    expect(container.querySelector(".katex")).not.toBeInTheDocument();
  });
});
