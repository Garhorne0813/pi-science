import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnArtifactStrip } from "./TurnArtifactStrip";

const { openInspector, mockReadArtifact } = vi.hoisted(() => ({ openInspector: vi.fn(), mockReadArtifact: vi.fn() }));

vi.mock("../../lib/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ui")>();
  return {
    ...actual,
    useUiStore: (selector: (state: { openInspector: typeof openInspector }) => unknown) => selector({ openInspector }),
  };
});

vi.mock("../../lib/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/files")>();
  return {
    ...actual,
    readArtifact: mockReadArtifact,
  };
});

function snippetFile(encoding: "utf8" | "base64" = "utf8") {
  return { path: "x", mime: "text/plain", encoding, data: "x", size: 1 };
}

beforeEach(() => {
  mockReadArtifact.mockReset();
  // Default: snippet reads fail → cards degrade to icon-only.
  mockReadArtifact.mockResolvedValue(null);
});

describe("TurnArtifactStrip", () => {
  it("renders image thumbnails with workspace preview URLs and file cards", () => {
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[
          { path: "work/plot.png", kind: "image", mime: "image/png", size: 2048 },
          { path: "results/summary.csv", kind: "table", mime: "text/csv", size: 512 },
        ]}
      />,
    );
    expect(screen.getByLabelText("Generated files")).toBeInTheDocument();
    const image = screen.getByAltText("plot.png");
    expect(image).toHaveAttribute("src", expect.stringContaining("/api/files/serve/work/plot.png"));
    expect(image).toHaveAttribute("loading", "lazy");
    expect(screen.getByText("summary.csv")).toBeInTheDocument();
  });

  it("collapses to 6 cards with a +N expander and expands on click", async () => {
    const user = userEvent.setup();
    const artifacts = Array.from({ length: 9 }, (_, index) => ({
      path: `work/f${index}.txt`, kind: "text" as const, mime: "text/plain", size: index,
    }));
    render(<TurnArtifactStrip cwd="/workspace" artifacts={artifacts} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
    await user.click(screen.getByText("+3"));
    await waitFor(() => expect(screen.queryByText("+3")).not.toBeInTheDocument());
    expect(screen.getByText("f8.txt")).toBeInTheDocument();
  });

  it("opens the inspector when a card is clicked", async () => {
    const user = userEvent.setup();
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "figures/a.png", kind: "image", mime: "image/png", size: 10 }]}
      />,
    );
    await user.click(screen.getByLabelText("a.png (figures/a.png)"));
    expect(openInspector).toHaveBeenCalledWith(expect.objectContaining({ variant: "file", path: "figures/a.png", cwd: "/workspace" }));
  });

  it("keeps an accessible card when the image source is unavailable", () => {
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "broken.png", kind: "image", mime: "image/png", size: 10 }]}
      />,
    );
    expect(screen.getByLabelText("broken.png (broken.png)")).toBeInTheDocument();
  });

  it("renders a mini table for csv snippets", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "gene,value\nA,1.0\nB,2.0\nC,3.0\nD,4.0\nE,5.0\nF,6.0" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/summary.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    expect(await screen.findByRole("cell", { name: "1.0" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "gene" })).toBeInTheDocument();
    // Truncated window: the ellipsis replaces the last parsed row (3.0), so
    // the last visible data row is 2.0.
    expect(screen.getByRole("cell", { name: "2.0" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "3.0" })).not.toBeInTheDocument();
    expect(mockReadArtifact).toHaveBeenCalledWith("results/summary.csv", "workspace", "/workspace", 8192);
    mockReadArtifact.mockReset();
  });

  it("renders a markdown excerpt for .md files", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "# Title\n\nSome **bold** analysis text." });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "report.md", kind: "text", mime: "text/markdown", size: 64 }]}
      />,
    );
    expect(await screen.findByText(/Title/)).toBeInTheDocument();
    mockReadArtifact.mockReset();
  });

  it("renders a code snippet for python files", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "import pandas as pd\ndf = pd.read_csv(\"x.csv\")\nprint(df.head())" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "scripts/analysis.py", kind: "code", mime: "text/x-python", size: 128 }]}
      />,
    );
    expect(await screen.findByText(/import pandas as pd/)).toBeInTheDocument();
    mockReadArtifact.mockReset();
  });

  it("falls back to the icon card when the snippet read fails or is binary", async () => {
    mockReadArtifact.mockResolvedValue(null);
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/summary.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText("summary.csv")).toBeInTheDocument();
    });
    mockReadArtifact.mockReset();

    mockReadArtifact.mockResolvedValue({ ...snippetFile("base64"), data: "aGVsbG8=" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "x.pdf", kind: "document", mime: "application/pdf", size: 10 }]}
      />,
    );
    expect(await screen.findByText("x.pdf")).toBeInTheDocument();
    mockReadArtifact.mockReset();
  });

  it("keeps icon cards for binary table formats like xlsx", async () => {
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "data/table.xlsx", kind: "table", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1024 }]}
      />,
    );
    expect(screen.getByText("table.xlsx")).toBeInTheDocument();
    expect(mockReadArtifact).not.toHaveBeenCalled();
  });

  it("lays cards out in a fill-then-wrap grid with glass styling", () => {
    const { container } = render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[
          { path: "work/a.png", kind: "image", mime: "image/png", size: 10 },
          { path: "work/b.txt", kind: "text", mime: "text/plain", size: 10 },
        ]}
      />,
    );
    const grid = container.querySelector("section > div");
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain("grid");
    expect(grid!.className).toContain("grid-cols-[repeat(auto-fill,minmax(140px,1fr))]");
    // Every card (image thumbnail and icon card) uses the glass shell.
    const cards = container.querySelectorAll("section > div > button");
    expect(cards.length).toBe(2);
    cards.forEach((card) => {
      expect(card.className).toContain("backdrop-blur-xl");
      expect(card.className).toContain("bg-white/45");
      expect(card.className).toContain("dark:bg-black/25");
      expect(card.className).toContain("w-full");
    });
  });

  it("shows a code fade mask on snippet cards and no token-opacity classes", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "import os\nprint('x' * 400)\n" });
    const { container } = render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "work/script.py", kind: "code", mime: "text/x-python", size: 512 }]}
      />,
    );
    await screen.findByLabelText("script.py (work/script.py)");
    const fades = container.querySelectorAll("[class*='bg-gradient-to-l']");
    expect(fades.length).toBe(1);
    // No token-opacity utilities (they are no-ops with CSS-variable colors);
    // native-color opacities like white/60 and black/25 are valid glass styles.
    const buttons = container.querySelectorAll("button");
    buttons.forEach((button) => {
      expect(button.className).not.toMatch(/(?:muted|surface|accent|border|text|ok|warn|error)\/\d{2}\b/);
    });
    mockReadArtifact.mockReset();
  });

  it("shows an ellipsis row only when the csv snippet is truncated and keeps the last visible row", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "a,b\n1,2\n3,4\n5,6\n7,8" });
    const { container } = render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/t.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    await screen.findByRole("cell", { name: "1" });
    // Truncated: ellipsis row shown, and the dropped last row (7,8) is not.
    expect(container.querySelector("tbody")!.textContent).toContain("…");
    expect(container.querySelector("tbody")!.textContent).not.toContain("7");
    mockReadArtifact.mockReset();
  });

  it("shows every row including the last one when the csv snippet is not truncated", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "a,b\n1,2\n3,4" });
    const { container } = render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/t.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    await screen.findByRole("cell", { name: "1" });
    // Untruncated: every data row renders, including the last one (3,4).
    expect(screen.getByRole("cell", { name: "4" })).toBeInTheDocument();
    expect(container.querySelector("tbody")!.textContent).not.toContain("…");
    mockReadArtifact.mockReset();
  });

  it("drops the last row in favor of an ellipsis row when the csv snippet is truncated", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "a,b\n1,2\n3,4\n5,6\n7,8\n9,0\n10,11\n12,13\n14,15\n16,17\n18,19\n20,21\n" });
    const { container } = render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/t.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    await screen.findByRole("cell", { name: "1" });
    expect(container.querySelector("tbody")!.textContent).toContain("…");
    // The truncated last row (20,21) is replaced by the ellipsis, not rendered.
    expect(container.querySelector("tbody")!.textContent).not.toContain("21");
    mockReadArtifact.mockReset();
  });
});
