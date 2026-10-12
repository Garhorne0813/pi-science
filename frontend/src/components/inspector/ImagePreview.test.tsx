import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ImagePreview } from "./ImagePreview";
let resize: () => void;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("fits image dimensions, changes magnification independently, and restores fit after resize", () => {
  render(<ImagePreview url="/sample.png" filename="sample.png" />);
  const img = screen.getByRole("img") as HTMLImageElement;
  const viewport = img.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 232 } });
  act(() => resize());
  Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
  fireEvent.load(img);
  expect(img).toHaveStyle({ width: "400px", height: "200px" });
  fireEvent.click(screen.getByRole("button", { name: "Original size" }));
  expect(img).toHaveStyle({ width: "800px", height: "400px" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(img).toHaveStyle({ width: "960px", height: "480px" });
  act(() => resize());
  expect(img).toHaveStyle({ width: "960px" });
  fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
  expect(img).toHaveStyle({ width: "400px" });
  expect(screen.getByText("800 × 400 px")).toBeInTheDocument();
});

it.each([10_000, 1_000_000])("zooms a %i pixel image continuously from fit with buttons and pinch gestures", (pixels) => {
  render(<ImagePreview url="/large.png" filename="large.png" />);
  const img = screen.getByRole("img") as HTMLImageElement;
  const viewport = img.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 432 } });
  act(() => resize());
  Object.defineProperties(img, { naturalWidth: { value: pixels }, naturalHeight: { value: pixels } });
  fireEvent.load(img);
  expect(parseFloat(img.style.width)).toBeCloseTo(400);
  expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(parseFloat(img.style.width)).toBeCloseTo(480);
  fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(parseFloat(img.style.width)).toBeCloseTo(400 / 1.2);
  for (const modifier of ["ctrlKey", "metaKey"]) {
    fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
    fireEvent.wheel(viewport, { [modifier]: true, deltaY: -100 });
    expect(parseFloat(img.style.width)).toBeCloseTo(400 * Math.exp(0.2));
    fireEvent.wheel(viewport, { [modifier]: true, deltaY: 100 });
    expect(parseFloat(img.style.width)).toBeCloseTo(400);
  }
});

it.each(["ctrlKey", "metaKey"])("accumulates a batch of %s wheel events before rendering", (modifier) => {
  render(<ImagePreview url="/batch.png" filename="batch.png" />);
  const img = screen.getByRole("img") as HTMLImageElement;
  const viewport = img.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 432 } });
  act(() => resize());
  Object.defineProperties(img, { naturalWidth: { value: 10_000 }, naturalHeight: { value: 10_000 } });
  fireEvent.load(img);
  act(() => {
    for (let i = 0; i < 3; i++) viewport.dispatchEvent(new WheelEvent("wheel", { [modifier]: true, deltaY: -100, bubbles: true, cancelable: true }));
  });
  expect(parseFloat(img.style.width)).toBeCloseTo(400 * Math.exp(0.6));
});
