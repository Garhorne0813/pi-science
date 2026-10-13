import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { FitsView } from "./FitsView";
function imageBytes() {
  const card = (key: string, value?: string) => (key.padEnd(8) + (value === undefined ? "" : `= ${value.padStart(20)}`)).padEnd(80);
  const header = [card("SIMPLE", "T"), card("BITPIX", "16"), card("NAXIS", "2"), card("NAXIS1", "2"), card("NAXIS2", "2"), card("END")].join("").padEnd(2880);
  const bytes = new Uint8Array(5760);
  bytes.set(new TextEncoder().encode(header));
  const data = new DataView(bytes.buffer);
  [10, 20, 30, 40].forEach((value, i) => data.setInt16(2880 + i * 2, value, false));
  return bytes.buffer;
}
let resize: () => void;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("fits a scientific image while preserving bottom-left pixel coordinates under magnification", () => {
  const { container } = render(<FitsView filename="image.fits" bytes={imageBytes()} />);
  const canvas = container.querySelector("canvas")!;
  const viewport = canvas.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 232 }, clientHeight: { value: 232 } });
  act(() => resize());
  expect(canvas).toHaveStyle({ width: "200px", height: "200px" });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 200, height: 200 } as DOMRect);
  fireEvent.mouseMove(canvas, { clientX: 150, clientY: 50 });
  expect(screen.getByText(/40\.000/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Original size" }));
  expect(canvas).toHaveStyle({ width: "2px", height: "2px" });
  fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
  expect(canvas).toHaveStyle({ width: "200px", height: "200px" });
});

it("zooms a tiny FITS image in either direction from a fit scale above the nominal maximum", () => {
  const { container } = render(<FitsView filename="tiny.fits" bytes={imageBytes()} />);
  const canvas = container.querySelector("canvas")!;
  const viewport = canvas.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 432 } });
  act(() => resize());
  expect(canvas).toHaveStyle({ width: "400px", height: "400px" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(parseFloat(canvas.style.width)).toBeCloseTo(480);
  fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(parseFloat(canvas.style.width)).toBeCloseTo(400 / 1.2);
  fireEvent.click(screen.getByRole("button", { name: "Original size" }));
  expect(canvas).toHaveStyle({ width: "2px" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(parseFloat(canvas.style.width)).toBeCloseTo(2.4);
});
