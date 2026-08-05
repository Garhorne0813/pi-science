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
    expect(divider).toHaveAttribute("tabindex", "0");
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1, clientX: 604 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 700 });

    expect(divider).toHaveAttribute("aria-valuenow", "324");
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(useUiStore.getState().inspectorWidth).toBe(324);
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
});
