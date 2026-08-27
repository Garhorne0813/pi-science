import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { INSPECTOR_LAYOUT_CHANGE_EVENT } from "@/lib/ui/inspector-layout";
import { MoleculeView } from "./MoleculeView";

const viewerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  applyStylePreset: vi.fn(),
  resize: vi.fn(),
  fitToViewport: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@/lib/viewers/molstar", () => ({
  createMolstarViewer: viewerMocks.create,
}));

describe("MoleculeView", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    viewerMocks.load.mockResolvedValue({ atomCount: 42, hasSequence: true, format: "pdb" });
    viewerMocks.applyStylePreset.mockResolvedValue(undefined);
    viewerMocks.create.mockResolvedValue({
      load: viewerMocks.load,
      applyStylePreset: viewerMocks.applyStylePreset,
      resize: viewerMocks.resize,
      fitToViewport: viewerMocks.fitToViewport,
      dispose: viewerMocks.dispose,
    });
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the structure through Mol* and reports the parsed atom count", async () => {
    render(<MoleculeView filename="protein.pdb" text="ATOM" />);

    await waitFor(() => expect(viewerMocks.load).toHaveBeenCalledWith("protein.pdb", "ATOM"));
    expect(await screen.findByText("42 atoms")).toBeInTheDocument();
    expect(screen.getByText("Mol*")).toBeInTheDocument();
  });

  it("disposes the viewer when the preview unmounts", async () => {
    const { unmount } = render(<MoleculeView filename="protein.pdb" text="ATOM" />);
    await waitFor(() => expect(viewerMocks.create).toHaveBeenCalledOnce());

    unmount();

    expect(viewerMocks.dispose).toHaveBeenCalledOnce();
  });

  it("offers common styles without requiring the Mol* side panel", async () => {
    render(<MoleculeView filename="protein.pdb" text="ATOM" />);
    await screen.findByText("42 atoms");

    const cartoon = screen.getByRole("button", { name: "Cartoon" });
    fireEvent.click(cartoon);

    await waitFor(() => expect(viewerMocks.applyStylePreset).toHaveBeenCalledWith("cartoon"));
    expect(cartoon).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("toolbar", { name: "Molecule styles" })).toBeInTheDocument();
  });

  it("refits the structure after the inspector is maximized", async () => {
    let notifyResize!: ResizeObserverCallback;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<MoleculeView filename="protein.pdb" text="ATOM" />);
    await screen.findByText("42 atoms");

    notifyResize([{ contentRect: { width: 420, height: 500 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(viewerMocks.fitToViewport).not.toHaveBeenCalled();
    notifyResize([{ contentRect: { width: 1_000, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver);

    expect(viewerMocks.resize).toHaveBeenCalled();
    expect(viewerMocks.fitToViewport).toHaveBeenCalledOnce();
  });

  it("refits when either inspector layout button explicitly signals a change", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<MoleculeView filename="protein.pdb" text="ATOM" />);
    await screen.findByText("42 atoms");

    window.dispatchEvent(new Event(INSPECTOR_LAYOUT_CHANGE_EVENT));

    expect(viewerMocks.resize).toHaveBeenCalled();
    expect(viewerMocks.fitToViewport).toHaveBeenCalledOnce();
  });

  it("shows the existing error boundary when Mol* rejects the file", async () => {
    viewerMocks.load.mockRejectedValueOnce(new Error("invalid structure"));
    render(<MoleculeView filename="broken.pdb" text="invalid" />);

    expect(await screen.findByText(/Failed to load structure/)).toBeInTheDocument();
  });

  it("distinguishes viewer initialization failures from invalid structures", async () => {
    viewerMocks.create.mockRejectedValueOnce(new Error("viewer init failed"));
    render(<MoleculeView filename="protein.pdb" text="ATOM" />);

    expect(await screen.findByText(/Failed to start the molecular viewer/)).toBeInTheDocument();
    expect(viewerMocks.load).not.toHaveBeenCalled();
  });
});
