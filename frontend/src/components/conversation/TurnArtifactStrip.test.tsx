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
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "gene,value\nA,1.0\nB,2.0\nC,3.0\nD,4.0" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/summary.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    expect(await screen.findByRole("cell", { name: "1.0" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "gene" })).toBeInTheDocument();
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
});
