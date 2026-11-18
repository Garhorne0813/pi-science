export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PixelPoint {
  x: number;
  y: number;
}

export function imagePoint(image: HTMLImageElement, clientX: number, clientY: number): PixelPoint {
  const bounds = image.getBoundingClientRect();
  const fraction = (offset: number, length: number) => Math.max(0, Math.min(1, offset / length));
  return {
    x: Math.round(fraction(clientX - bounds.left, bounds.width) * image.naturalWidth),
    y: Math.round(fraction(clientY - bounds.top, bounds.height) * image.naturalHeight),
  };
}

export function pixelRect(start: PixelPoint, end: PixelPoint): PixelRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  };
}

// Store both views in one PNG so the transcript retains the original context
// even if the workspace image changes. Only the overview carries the outline.
export async function regionSnapshot(image: HTMLImageElement, rect: PixelRect): Promise<Blob> {
  const fit = (width: number, height: number, limit: number) => {
    const scale = Math.min(1, limit / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  };
  const overview = fit(image.naturalWidth, image.naturalHeight, 768);
  const detail = fit(rect.width, rect.height, 1280);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(overview.width, detail.width);
  canvas.height = overview.height + 8 + detail.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(image, 0, 0, overview.width, overview.height);
  const sx = overview.width / image.naturalWidth;
  const sy = overview.height / image.naturalHeight;
  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x * sx, rect.y * sy, rect.width * sx, rect.height * sy);
  ctx.drawImage(
    image,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    overview.height + 8,
    detail.width,
    detail.height,
  );
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    ),
  );
}
