import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MoleculeThumb } from "./MoleculeThumb";

// 3Dmol is imported dynamically; mock the module so jsdom never touches WebGL.
const fakeViewer = {
  setBackgroundColor: vi.fn(),
  addModel: vi.fn(),
  selectedAtoms: vi.fn(() => [{ index: 0 }]),
  setStyle: vi.fn(),
  zoomTo: vi.fn(),
  render: vi.fn(),
  pngURI: vi.fn(() => "data:image/png;base64,UE5H"),
  clear: vi.fn(),
};

vi.mock("3dmol", () => ({
  createViewer: vi.fn(() => fakeViewer),
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
  /** Test helper: fire an intersection for the observed element. */
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
    fakeViewer.pngURI.mockReturnValue("data:image/png;base64,UE5H");
    fakeViewer.selectedAtoms.mockReturnValue([{ index: 0 }]);
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).IntersectionObserver = OriginalIO;
  });

  it("does not read the file or create a viewer until scrolled into view", async () => {
    render(<MoleculeThumb path="a.pdb" cwd="/ws" filename="a.pdb" />);
    const { readArtifact } = vi.mocked(await import("@/lib/files/files"));
    expect(readArtifact).not.toHaveBeenCalled();
    expect(fakeViewer.addModel).not.toHaveBeenCalled();
  });

  it("renders a static image after the card enters the viewport", async () => {
    const { container } = render(<MoleculeThumb path="a.pdb" cwd="/ws" filename="a.pdb" />);
    MockIntersectionObserver.instances[0].intersect();
    await waitFor(() => {
      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toContain("data:image/png");
    });
    const { readArtifact } = vi.mocked(await import("@/lib/files/files"));
    expect(readArtifact).toHaveBeenCalledWith("a.pdb", "workspace", "/ws", expect.any(Number));
  });

  it("calls onError and shows the fallback when 3Dmol finds no atoms", async () => {
    fakeViewer.selectedAtoms.mockReturnValue([]);
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
