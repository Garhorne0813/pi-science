import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MoleculeThumb } from "./MoleculeThumb";

const thumbnailMocks = vi.hoisted(() => ({
  cacheKey: vi.fn(() => "cache-key"),
  render: vi.fn(async () => "data:image/png;base64,UE5H"),
}));

vi.mock("@/lib/viewers/molecule-thumbnail", () => ({
  moleculeThumbnailCacheKey: thumbnailMocks.cacheKey,
  renderMoleculeThumbnail: thumbnailMocks.render,
}));

vi.mock("@/lib/files/files", () => ({
  readArtifact: vi.fn(async () => ({
    path: "x.pdb",
    encoding: "utf8" as const,
    data: "ATOM      1  CA  GLY A   1       1.000   1.000   1.000  1.00 20.00           C",
    size: 100,
  })),
}));

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  private callback: IntersectionObserverCallback;
  private elements = new Set<Element>();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) { this.elements.add(el); }
  unobserve(el: Element) { this.elements.delete(el); }
  disconnect() { this.elements.clear(); }
  intersect() {
    for (const el of this.elements) {
      this.callback([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
  }
}

const OriginalIO = globalThis.IntersectionObserver;

describe("MoleculeThumb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
    MockIntersectionObserver.instances = [];
    thumbnailMocks.render.mockResolvedValue("data:image/png;base64,UE5H");
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).IntersectionObserver = OriginalIO;
  });

  it("does not read the file or queue a render until scrolled into view", async () => {
    render(<MoleculeThumb path="a.pdb" cwd="/ws" filename="a.pdb" />);
    const { readArtifact } = vi.mocked(await import("@/lib/files/files"));
    expect(readArtifact).not.toHaveBeenCalled();
    expect(thumbnailMocks.render).not.toHaveBeenCalled();
  });

  it("renders a static image after the card enters the viewport", async () => {
    const { container } = render(<MoleculeThumb path="a.pdb" cwd="/ws" filename="a.pdb" />);
    MockIntersectionObserver.instances[0].intersect();
    await waitFor(() => {
      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toContain("data:image/png");
      expect(img?.className).toContain("object-cover");
    });
    const { readArtifact } = vi.mocked(await import("@/lib/files/files"));
    expect(readArtifact).toHaveBeenCalledWith("a.pdb", "workspace", "/ws", expect.any(Number));
    expect(thumbnailMocks.render).toHaveBeenCalledWith(expect.objectContaining({ filename: "a.pdb", cacheKey: "cache-key" }));
  });

  it("refetches a truncated structure so every chain reaches the thumbnail renderer", async () => {
    const { readArtifact } = vi.mocked(await import("@/lib/files/files"));
    vi.mocked(readArtifact)
      .mockResolvedValueOnce({
        path: "dimer.pdb",
        mime: "chemical/x-pdb",
        encoding: "utf8",
        data: "ATOM chain A",
        size: 400_000,
        truncated: true,
      })
      .mockResolvedValueOnce({
        path: "dimer.pdb",
        mime: "chemical/x-pdb",
        encoding: "utf8",
        data: "ATOM chain A\nATOM chain B",
        size: 400_000,
        truncated: false,
      });

    render(<MoleculeThumb path="dimer.pdb" cwd="/ws" filename="dimer.pdb" />);
    MockIntersectionObserver.instances[0].intersect();

    await waitFor(() => expect(thumbnailMocks.render).toHaveBeenCalledWith(expect.objectContaining({
      filename: "dimer.pdb",
      text: "ATOM chain A\nATOM chain B",
    })));
    expect(readArtifact).toHaveBeenNthCalledWith(1, "dimer.pdb", "workspace", "/ws", 256 * 1024);
    expect(readArtifact).toHaveBeenNthCalledWith(2, "dimer.pdb", "workspace", "/ws", 16 * 1024 * 1024);
  });

  it("does not render a misleading prefix when the complete structure exceeds the thumbnail limit", async () => {
    const { readArtifact } = vi.mocked(await import("@/lib/files/files"));
    vi.mocked(readArtifact)
      .mockResolvedValueOnce({
        path: "huge-complex.pdb",
        mime: "chemical/x-pdb",
        encoding: "utf8",
        data: "ATOM partial chain A",
        size: 256 * 1024,
        truncated: true,
      })
      .mockResolvedValueOnce({
        path: "huge-complex.pdb",
        mime: "chemical/x-pdb",
        encoding: "utf8",
        data: "ATOM still incomplete",
        size: 16 * 1024 * 1024,
        truncated: true,
      });
    const onError = vi.fn();

    render(<MoleculeThumb path="huge-complex.pdb" cwd="/ws" filename="huge-complex.pdb" onError={onError} />);
    MockIntersectionObserver.instances[0].intersect();

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(readArtifact).toHaveBeenCalledTimes(2);
    expect(thumbnailMocks.render).not.toHaveBeenCalled();
  });

  it("calls onError and shows the fallback when Mol* cannot render the structure", async () => {
    thumbnailMocks.render.mockRejectedValueOnce(new Error("no atoms"));
    const onError = vi.fn();
    render(<MoleculeThumb path="a.pdb" cwd="/ws" filename="a.pdb" onError={onError} />);
    MockIntersectionObserver.instances[0].intersect();
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it("calls onError when the fragment cannot be read", async () => {
    const { readArtifact } = vi.mocked(await import("@/lib/files/files"));
    vi.mocked(readArtifact).mockResolvedValueOnce(null);
    const onError = vi.fn();
    render(<MoleculeThumb path="a.pdb" cwd="/ws" filename="a.pdb" onError={onError} />);
    MockIntersectionObserver.instances[0].intersect();
    await waitFor(() => expect(onError).toHaveBeenCalled());
  });
});
