import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ImagePreview } from "./ImagePreview";
import { RegionAskError } from "./image-region-ask";
let resize: () => void;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("fits image dimensions, changes magnification independently, and restores fit after resize", () => {
  render(<ImagePreview url="/sample.png" filename="sample.png" />);
  const img = screen.getByRole("img") as HTMLImageElement;
  const viewport = img.parentElement!.parentElement!.parentElement!;
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
  const viewport = img.parentElement!.parentElement!.parentElement!;
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
  const viewport = img.parentElement!.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 432 } });
  act(() => resize());
  Object.defineProperties(img, { naturalWidth: { value: 10_000 }, naturalHeight: { value: 10_000 } });
  fireEvent.load(img);
  act(() => {
    for (let i = 0; i < 3; i++) viewport.dispatchEvent(new WheelEvent("wheel", { [modifier]: true, deltaY: -100, bubbles: true, cancelable: true }));
  });
  expect(parseFloat(img.style.width)).toBeCloseTo(400 * Math.exp(0.6));
});

it("retains the selected source pixels after a failed attachment and supports keyboard retry", async () => {
  const onAsk = vi.fn().mockRejectedValueOnce(new Error("Upload failed")).mockResolvedValue(true);
  render(<ImagePreview url="/plot.png" filename="plot.png" onAsk={onAsk} />);
  const image = screen.getByRole("img");
  const viewport = image.parentElement!.parentElement!.parentElement!;
  Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 232 } });
  act(() => resize());
  Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
  fireEvent.load(image);
  fireEvent.click(screen.getByRole("button", { name: "Select image region" }));
  expect(screen.queryByRole("textbox", { name: "Ask about region" })).not.toBeInTheDocument();
  const surface = screen.getByRole("group", { name: /Use arrow keys/ });
  fireEvent.keyDown(surface, { key: "ArrowRight" });
  fireEvent.keyDown(surface, { key: "ArrowDown", shiftKey: true });
  const input = screen.getByRole("textbox", { name: "Ask about region" });
  const ask = screen.getByRole("button", { name: "Send message" });
  expect(ask).toBeDisabled();
  fireEvent.change(input, { target: { value: "What is in the region?" } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onAsk).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(input).toHaveValue("What is in the region?");
  await act(async () => { fireEvent.click(ask); });
  expect(onAsk).toHaveBeenCalledTimes(2);
  expect(onAsk).toHaveBeenLastCalledWith(image, { x: 8, y: 0, width: 200, height: 104 }, "What is in the region?");
  expect(screen.queryByRole("textbox", { name: "Ask about region" })).not.toBeInTheDocument();
});

it.each(["rejected", "network"] as const)(
  "explains a %s attachment failure and keeps the original error for the console",
  async (kind) => {
    const failure = new RegionAskError(kind, "server said no");
    const onAsk = vi.fn().mockRejectedValueOnce(failure);
    render(<ImagePreview url="/region.png" filename="region.png" onAsk={onAsk} />);
    const image = screen.getByRole("img");
    const viewport = image.parentElement!.parentElement!.parentElement!;
    Object.defineProperties(viewport, { clientWidth: { value: 432 }, clientHeight: { value: 232 } });
    act(() => resize());
    Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    fireEvent.load(image);
    fireEvent.click(screen.getByRole("button", { name: "Select image region" }));
    const surface = screen.getByRole("group", { name: /Use arrow keys/ });
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    fireEvent.change(screen.getByRole("textbox", { name: "Ask about region" }), { target: { value: "What is this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const copy = kind === "rejected" ? /rejected the region upload/ : /Could not reach the workspace/;
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      "Could not submit the image region question",
      failure,
    );
  },
);
