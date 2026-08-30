import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReferencedArtifactStrip, TurnArtifactStrip } from "./TurnArtifactStrip";

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

vi.mock("./MoleculeThumb", () => ({
  MoleculeThumb: () => <div data-testid="molecule-thumb" />,
}));

function snippetFile(encoding: "utf8" | "base64" = "utf8") {
  return { path: "x", mime: "text/plain", encoding, data: "x", size: 1 };
}

beforeEach(() => {
  mockReadArtifact.mockReset();
  // Default: snippet reads fail → cards degrade to icon-only.
  mockReadArtifact.mockResolvedValue(null);
});

describe("TurnArtifactStrip", () => {
  it("renders verified workspace paths cited by the final answer", async () => {
    mockReadArtifact.mockImplementation(async (path: string) => path === "work/plot.png" ? { path, mime: "image/png", encoding: "base64", data: "x", size: 2048 } : null);
    render(<ReferencedArtifactStrip cwd="/workspace" text="See `work/plot.png` and missing/file.pdf." />);
    await waitFor(() => expect(screen.getByLabelText("Referenced files")).toBeInTheDocument());
    expect(screen.getByText("REFERENCED · 1")).toBeInTheDocument();
  });

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
    expect(screen.getByText("GENERATED · 2")).toBeInTheDocument();
    const image = screen.getByAltText("plot.png");
    expect(image).toHaveAttribute("src", expect.stringContaining("/api/files/serve/work/plot.png"));
    expect(image).toHaveAttribute("loading", "lazy");
    // Claude Science style: contain (never crop) inside the darker preview area.
    expect(image.className).toContain("object-contain");
    expect(screen.getByLabelText("summary.csv (results/summary.csv)")).toBeInTheDocument();
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
    expect(screen.getByLabelText("f8.txt (work/f8.txt)")).toBeInTheDocument();
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

  it("renders a CSV summary badge with rows, columns, type hints and +N more", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "gene,value,fc,padj,log2\nA,1.0,2.5,0.01,3.1\nB,2.0,-1.2,0.04,-2.0\nC,3.0,0.8,0.9,0.4\nD,4.0,1.1,0.02,1.9\nE,5.0,3.3,0.001,4.2\nF,6.0,0.2,0.7,0.1" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/summary.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    expect(await screen.findByText("3+ rows · 5 columns")).toBeInTheDocument();
    // First three column names are rendered as chips, the rest collapse to +N more.
    expect(screen.getByText("gene")).toBeInTheDocument();
    expect(screen.getByText("value")).toBeInTheDocument();
    expect(screen.getByText("fc")).toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
    // Numeric columns show the 123 hint, text columns the abc hint.
    expect(screen.getAllByText("123").length).toBeGreaterThan(0);
    expect(screen.getAllByText("abc").length).toBeGreaterThan(0);
    expect(mockReadArtifact).toHaveBeenCalledWith("results/summary.csv", "workspace", "/workspace", 8192);
    mockReadArtifact.mockReset();
  });

  it("shows exact row count when the CSV snippet is not truncated", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "a,b\n1,2\n3,4" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/t.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    expect(await screen.findByText("2 rows · 2 columns")).toBeInTheDocument();
    expect(screen.queryByText(/\+ more/)).not.toBeInTheDocument();
    mockReadArtifact.mockReset();
  });

  it("shows every column name when the CSV has few columns", async () => {
    mockReadArtifact.mockResolvedValue({ ...snippetFile(), data: "a,b\n1,2\n3,4\n5,6\n7,8\n9,0" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/t.csv", kind: "table", mime: "text/csv", size: 512 }]}
      />,
    );
    await screen.findByText("3+ rows · 2 columns");
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
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
      expect(screen.getByLabelText("summary.csv (results/summary.csv)")).toBeInTheDocument();
    });
    mockReadArtifact.mockReset();

    mockReadArtifact.mockResolvedValue({ ...snippetFile("base64"), data: "aGVsbG8=" });
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "x.pdf", kind: "document", mime: "application/pdf", size: 10 }]}
      />,
    );
    expect(await screen.findByLabelText("x.pdf (x.pdf)")).toBeInTheDocument();
    mockReadArtifact.mockReset();
  });

  it("keeps icon cards for binary table formats like xlsx", async () => {
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "data/table.xlsx", kind: "table", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1024 }]}
      />,
    );
    expect(screen.getByLabelText("table.xlsx (data/table.xlsx)")).toBeInTheDocument();
    expect(mockReadArtifact).not.toHaveBeenCalled();
  });

  it("lays cards out in a fill-then-wrap flex row with Claude Science shell styling", () => {
    const { container } = render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[
          { path: "work/a.png", kind: "image", mime: "image/png", size: 10 },
          { path: "work/b.txt", kind: "text", mime: "text/plain", size: 10 },
        ]}
      />,
    );
    const row = container.querySelector("section > div:last-child");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("flex");
    expect(row!.className).toContain("flex-wrap");
    expect(row!.className).toContain("gap-2");
    // Every card uses the solid shell: fixed 128px, inset ring, no glass blur.
    const cards = container.querySelectorAll("section > div:last-child > button");
    expect(cards.length).toBe(2);
    cards.forEach((card) => {
      expect(card.className).toContain("w-[128px]");
      expect(card.className).toContain("ring-1");
      expect(card.className).toContain("ring-inset");
      expect(card.className).not.toContain("backdrop-blur");
      expect(card.className).not.toContain("bg-white/45");
    });
    // Each card carries the hover/focus open affordance, theme-adaptive.
    expect(container.querySelectorAll("[class*='group-hover:opacity-100']").length).toBe(2);
    const affordance = container.querySelector("[class*='bg-white/90']");
    expect(affordance).not.toBeNull();
    expect(affordance?.className).toContain("dark:bg-black/90");
    expect(affordance?.className).toContain("text-black/70");
    expect(affordance?.className).toContain("dark:text-white/80");
  });

  it("shows the GENERATED · N label above the card row", () => {
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "work/a.txt", kind: "text", mime: "text/plain", size: 10 }]}
      />,
    );
    expect(screen.getByText("GENERATED · 1")).toBeInTheDocument();
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
    // native-color opacities like ring-black/10 are valid.
    const buttons = container.querySelectorAll("button");
    buttons.forEach((button) => {
      expect(button.className).not.toMatch(/(?:muted|surface|accent|border|text|ok|warn|error)\/\d{2}\b/);
    });
    mockReadArtifact.mockReset();
  });

  it("splits filename and extension so the extension survives truncation", () => {
    const { container } = render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "results/very-long-name.csv", kind: "table", mime: "text/csv", size: 10 }]}
      />,
    );
    const card = container.querySelector("button");
    expect(card!.textContent).toContain(".csv");
    expect(card!.textContent).toContain("very-long-name");
  });

  it("renders structure artifacts through MoleculeThumb", () => {
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "work/protein.pdb", kind: "structure", mime: "chemical/x-pdb", size: 4096 }]}
      />,
    );
    expect(screen.getByTestId("molecule-thumb")).toBeTruthy();
    expect(screen.getByLabelText("protein.pdb (work/protein.pdb)")).toBeTruthy();
    // Structure cards must not trigger the 8KB snippet reader.
    expect(mockReadArtifact).not.toHaveBeenCalled();
  });

  it("keeps icon card for other kinds (structure path not taken)", () => {
    render(
      <TurnArtifactStrip
        cwd="/workspace"
        artifacts={[{ path: "work/notes.txt", kind: "text", mime: "text/plain", size: 32 }]}
      />,
    );
    expect(screen.queryByTestId("molecule-thumb")).toBeNull();
  });
});
