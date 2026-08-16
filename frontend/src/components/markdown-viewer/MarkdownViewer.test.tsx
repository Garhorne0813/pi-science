import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";
import { useUiStore } from "@/lib/ui";

afterEach(() => {
  useUiStore.setState({ inspectorOpen: false, inspectorData: null });
});

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

describe("MarkdownViewer code blocks", () => {
  it("renders a sticky banner with the fence language and a copy button in chat", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { container } = render(<MarkdownViewer>{`\`\`\`python
print(1)
\`\`\``}</MarkdownViewer>);
    const banner = container.querySelector(".sticky")!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("python");
    const copyButton = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("print(1)\n"));
  });

  it("keeps a plain pre in the document variant", () => {
    const { container } = render(<MarkdownViewer variant="document">{"```py\nprint(2)\n```"}</MarkdownViewer>);
    expect(container.querySelector(".sticky")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("lets compact previews opt out of code chrome", () => {
    const { container } = render(
      <MarkdownViewer codeChrome={false}>{"```py\nprint(3)\n```"}</MarkdownViewer>,
    );
    expect(container.querySelector(".sticky")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("MarkdownViewer images", () => {
  const CWD = "/Users/cyq/pi-science-workspaces/test";

  it("rewrites relative image src to the workspace file serve URL", () => {
    const { container } = render(
      <MarkdownViewer variant="document" resourceContext={{ cwd: CWD, documentPath: `${CWD}/reports/readme.md` }}>
        {"![plot](./images/plot.png)"}
      </MarkdownViewer>,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toContain("/api/files/serve/reports/images/plot.png?cwd=");
    expect(img.alt).toBe("plot");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("keeps http links untouched and shows a placeholder for filtered data URLs", () => {
    const { container, rerender } = render(
      <MarkdownViewer>{"![ext](https://example.com/a.png)"}</MarkdownViewer>,
    );
    expect((container.querySelector("img") as HTMLImageElement).src).toBe("https://example.com/a.png");
    // react-markdown v9 filters data: URLs to empty strings (safe-by-default);
    // our renderer must not render a broken <img> for that input.
    rerender(<MarkdownViewer>{"![d](data:image/png;base64,AAA)"}</MarkdownViewer>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Image failed to load");
  });

  it("resolves workspace-root shorthand in chat mode from codeRunner.cwd", () => {
    const { container } = render(
      <MarkdownViewer codeRunner={{ cwd: CWD, sessionId: "s1" }}>
        {"![f](/figures/a.png)"}
      </MarkdownViewer>,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.src).toContain("/api/files/serve/figures/a.png?cwd=");
  });

  it("shows a failure placeholder when the image cannot be resolved", () => {
    const { container } = render(
      <MarkdownViewer variant="document" resourceContext={{ cwd: CWD, documentPath: `${CWD}/reports/readme.md` }}>
        {"![x](../../../../escape.png)"}
      </MarkdownViewer>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Image failed to load");
  });

  it("shows a failure placeholder when the image request errors", () => {
    const { container } = render(
      <MarkdownViewer variant="document" resourceContext={{ cwd: CWD, documentPath: `${CWD}/reports/readme.md` }}>
        {"![x](./missing.png)"}
      </MarkdownViewer>,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Image failed to load");
  });

  it("opens a workspace-relative local link in the inspector", () => {
    render(
      <MarkdownViewer variant="document" resourceContext={{ cwd: CWD, documentPath: `${CWD}/reports/readme.md` }}>
        {"[data](../data/raw.csv)"}
      </MarkdownViewer>,
    );
    const link = screen.getByRole("link", { name: "data" });
    fireEvent.click(link);
    const state = useUiStore.getState();
    expect(state.inspectorOpen).toBe(true);
    expect(state.inspectorData).toMatchObject({ path: "data/raw.csv" });
  });
});

describe("MarkdownViewer document structure", () => {
  it("hides raw HTML comments used for document metadata", () => {
    const { container } = render(
      <MarkdownViewer variant="document">{"# Visible\n\n<!-- internal metadata -->\n\nVisible text"}</MarkdownViewer>,
    );
    expect(container.textContent).toContain("Visible text");
    expect(container.textContent).not.toContain("internal metadata");
  });

  it("preserves GFM table alignment styles", () => {
    const { container } = render(
      <MarkdownViewer variant="document">
        {"| Label | Value |\n| :--- | ---: |\n| pH | 7.4 |"}
      </MarkdownViewer>,
    );
    const cells = Array.from(container.querySelectorAll("th, td"));
    expect(cells[0]).toHaveStyle({ textAlign: "left" });
    expect(cells[1]).toHaveStyle({ textAlign: "right" });
    expect(cells[3]).toHaveStyle({ textAlign: "right" });
  });

  it("keeps level-five and level-six headings styled", () => {
    const { container } = render(
      <MarkdownViewer variant="document">{"##### Subsection\n\n###### Detail"}</MarkdownViewer>,
    );
    expect(container.querySelector("h5")).toHaveClass("font-semibold");
    expect(container.querySelector("h6")).toHaveClass("font-semibold");
  });

  it("uses compact chat-like typography in document previews", () => {
    const { container } = render(
      <MarkdownViewer variant="document">{"# Heading\n\nBody text"}</MarkdownViewer>,
    );
    expect(container.firstElementChild).toHaveClass("text-[15px]", "leading-[1.65]");
    expect(container.querySelector("h1")).toHaveClass("text-2xl", "mt-5");
    expect(container.querySelector("p")).toHaveClass("my-1.5");
  });

  it("wraps long links and inline code inside narrow previews", () => {
    const { container } = render(
      <MarkdownViewer variant="document">
        {"[polymer entity](https://data.rcsb.org/rest/v1/core/polymer_entity/{id}/1)\n\n`data.rcsb.org/rest/v1/core/polymer_entity/{id}/1`"}
      </MarkdownViewer>,
    );
    expect(container.querySelector("a")).toHaveClass("[overflow-wrap:anywhere]");
    expect(container.querySelector("code")).toHaveClass("[overflow-wrap:anywhere]");
  });
});
