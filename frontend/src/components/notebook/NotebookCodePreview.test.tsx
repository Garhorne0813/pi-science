import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotebookCodePreview } from "./NotebookCodePreview";

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
});
