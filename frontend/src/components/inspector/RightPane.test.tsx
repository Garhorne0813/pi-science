import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RightPane } from "./RightPane";
import { useUiStore } from "@/lib/ui";
import i18n from "@/i18n";

describe("RightPane resizing", () => {
  let captured = false;

  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    captured = false;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: () => {
        captured = true;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => captured,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: () => {
        captured = false;
      },
    });
    useUiStore.setState({ inspectorWidth: 420, inspectorMaximized: false });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
    Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
    Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
  });

  it("updates the live pane width during a pointer drag and persists on release", () => {
    render(
      <RightPane onClose={vi.fn()}>
        <div>Preview</div>
      </RightPane>,
    );

    const divider = screen.getByRole("separator", { name: "Resize preview panel" });
    const pane = divider.parentElement!;
    expect(divider).toHaveAttribute("tabindex", "0");
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1, clientX: 604 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 700 });

    expect(divider).toHaveAttribute("aria-valuenow", "324");
    expect(pane).toHaveStyle({ width: "324px" });
    expect(useUiStore.getState().inspectorWidth).toBe(420);
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(useUiStore.getState().inspectorWidth).toBe(324);
  });

  it("coalesces repeated pointer moves into one animation-frame width update", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    render(
      <RightPane onClose={vi.fn()}>
        <div>Preview</div>
      </RightPane>,
    );

    const divider = screen.getByRole("separator", { name: "Resize preview panel" });
    const pane = divider.parentElement!;
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 680 });

    expect(frames).toHaveLength(1);
    expect(pane).toHaveStyle({ width: "420px" });
    frames[0](0);
    expect(pane).toHaveStyle({ width: "344px" });
    expect(useUiStore.getState().inspectorWidth).toBe(420);
    fireEvent.pointerUp(divider, { pointerId: 1 });
  });

  it("supports keyboard width adjustments on the divider", () => {
    render(
      <RightPane onClose={vi.fn()}>
        <div>Preview</div>
      </RightPane>,
    );

    const divider = screen.getByRole("separator", { name: "Resize preview panel" });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });

    expect(useUiStore.getState().inspectorWidth).toBe(436);
    expect(divider).toHaveAttribute("aria-valuenow", "436");
  });

  it("fills the layout beside the sidebar when expanded", () => {
    useUiStore.setState({ inspectorMaximized: true });
    const { container } = render(
      <RightPane onClose={vi.fn()}>
        <div>Preview</div>
      </RightPane>,
    );

    expect(container.firstElementChild).toHaveClass("flex-1");
    expect(container.firstElementChild).not.toHaveClass("fixed", "inset-0");
  });
});
