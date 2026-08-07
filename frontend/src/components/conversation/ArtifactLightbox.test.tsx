import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactLightbox } from "./ArtifactLightbox";
import type { TurnArtifactItem } from "../../types/thread";

const { mockReadArtifact } = vi.hoisted(() => ({ mockReadArtifact: vi.fn() }));

vi.mock("../../lib/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/files")>();
  return { ...actual, readArtifact: mockReadArtifact };
});

// MoleculeView is lazy + WebGL (3dmol); render a stand-in.
vi.mock("../inspector/MoleculeView", () => ({
  MoleculeView: ({ filename }: { filename: string }) => (
    <div data-testid="molecule-view">{filename}</div>
  ),
}));

function item(overrides: Partial<TurnArtifactItem> = {}): TurnArtifactItem {
  return { path: "work/a.png", kind: "image", mime: "image/png", size: 10, ...overrides };
}

function renderLightbox(open = true) {
  const onOpenChange = vi.fn();
  const utils = render(
    <ArtifactLightbox item={open ? item() : null} cwd="/ws" open={open} onOpenChange={onOpenChange} />,
  );
  return { onOpenChange, ...utils };
}

describe("ArtifactLightbox", () => {
  beforeEach(() => {
    mockReadArtifact.mockReset();
    mockReadArtifact.mockResolvedValue(null);
  });

  it("renders an image at full size with a dialog role", () => {
    renderLightbox();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const img = screen.getByRole("img", { name: "a.png" });
    expect(img).toHaveAttribute("src", expect.stringContaining("/api/files/serve/work/a.png"));
  });

  it("loads structure text and renders the interactive MoleculeView", async () => {
    mockReadArtifact.mockResolvedValue({
      path: "work/1ake.pdb",
      mime: "text/plain",
      encoding: "utf8",
      data: "ATOM      1  N   GLY A   1",
      size: 24,
      truncated: false,
    });
    const { rerender } = render(
      <ArtifactLightbox
        item={item({ path: "work/1ake.pdb", kind: "structure", mime: "chemical/x-pdb" })}
        cwd="/ws"
        open
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("molecule-view")).toBeInTheDocument());
    expect(screen.getByTestId("molecule-view")).toHaveTextContent("1ake.pdb");
    expect(mockReadArtifact).toHaveBeenCalledWith("work/1ake.pdb", "workspace", "/ws", expect.any(Number));
    rerender(<ArtifactLightbox item={null} cwd="/ws" open={false} onOpenChange={vi.fn()} />);
  });

  it("shows a partial-load notice for truncated structure reads", async () => {
    mockReadArtifact.mockResolvedValue({
      path: "work/big.pdb",
      mime: "text/plain",
      encoding: "utf8",
      data: "ATOM",
      size: 4,
      truncated: true,
    });
    render(
      <ArtifactLightbox
        item={item({ path: "work/big.pdb", kind: "structure", mime: "chemical/x-pdb" })}
        cwd="/ws"
        open
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("molecule-view")).toBeInTheDocument());
    expect(screen.getByText(/first 4 MB/i)).toBeInTheDocument();
  });

  it("shows an error state when the file cannot be read", async () => {
    mockReadArtifact.mockResolvedValue(null);
    render(
      <ArtifactLightbox
        item={item({ path: "work/x.pdb", kind: "structure", mime: "chemical/x-pdb" })}
        cwd="/ws"
        open
        onOpenChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Unable to load file")).toBeInTheDocument());
  });

  it("closes via Escape and via the close button", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ArtifactLightbox item={item()} cwd="/ws" open onOpenChange={onOpenChange} />,
    );
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing when closed", () => {
    renderLightbox(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
