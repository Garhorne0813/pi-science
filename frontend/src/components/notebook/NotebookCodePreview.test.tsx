import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import hljs from "highlight.js/lib/common";
import { i18nReady } from "../../i18n";
import { NotebookCodePreview } from "./NotebookCodePreview";

await i18nReady;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function codeText(container: HTMLElement): string | null | undefined {
  return container.querySelector("code")?.textContent;
}

describe("NotebookCodePreview", () => {
  it("keeps line numbers aligned with the code typography", () => {
    const { container } = render(<NotebookCodePreview code={"first\nsecond\nthird"} />);
    const preview = container.querySelector(".notebook-code-preview");
    const gutter = preview?.firstElementChild;
    const code = preview?.querySelector("pre");

    expect(gutter).toHaveClass("text-[12.5px]", "leading-[1.65]");
    expect(code).toHaveClass("text-[12.5px]", "leading-[1.65]");
    expect(gutter).toHaveTextContent("123");
  });

  it("does not auto-detect a language the common bundle does not have", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const highlight = vi.spyOn(hljs, "highlight");
    const { container } = render(<NotebookCodePreview code={"<tag> & raw"} language="local" />);

    expect(auto).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe("<tag> & raw");
  });

  it("renders an explicit plaintext language without calling into highlight.js", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const highlight = vi.spyOn(hljs, "highlight");
    const { container } = render(<NotebookCodePreview code={"x = 1"} language="plaintext" />);

    expect(auto).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe("x = 1");
  });

  it("keeps highlighting the default Python cells", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    render(<NotebookCodePreview code={"x = 1"} />);

    expect(highlight).toHaveBeenCalledWith("x = 1", { language: "python" });
  });

  it("skips highlighting above the size guard", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    const code = "a".repeat(1_000_001);
    const { container } = render(<NotebookCodePreview code={code} language="python" />);

    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe(code);
  });
});
