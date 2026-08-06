import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnArtifactStrip } from "./TurnArtifactStrip";

const { openInspector } = vi.hoisted(() => ({ openInspector: vi.fn() }));

vi.mock("../../lib/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ui")>();
  return {
    ...actual,
    useUiStore: (selector: (state: { openInspector: typeof openInspector }) => unknown) => selector({ openInspector }),
  };
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
});
