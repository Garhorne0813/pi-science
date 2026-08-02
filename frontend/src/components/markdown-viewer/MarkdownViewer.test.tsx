import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

describe("MarkdownViewer mathematics", () => {
  it("renders inline and display math with KaTeX", () => {
    const { container } = render(
      <MarkdownViewer>
        {"Inline $E = mc^2$\n\n$$\n\\frac{a}{b} = c\n$$"}
      </MarkdownViewer>,
    );
    expect(container.querySelector(".katex")).toBeInTheDocument();
    expect(container.querySelector(".katex-display .katex")).toBeInTheDocument();
  });

  it("keeps rendering when a formula contains unsupported LaTeX", () => {
    expect(() => render(<MarkdownViewer>{"$\\notARealCommand$"}</MarkdownViewer>)).not.toThrow();
  });

  it("copies the original TeX source for a display formula", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { container } = render(<MarkdownViewer>{"$$\n\\frac{a}{b} = c\n$$"}</MarkdownViewer>);
    const copyButton = container.querySelector("button[aria-label]");

    expect(copyButton).toBeInTheDocument();
    fireEvent.click(copyButton!);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("\\frac{a}{b} = c"));
  });
});
