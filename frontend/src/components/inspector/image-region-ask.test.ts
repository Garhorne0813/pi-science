import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { isImageRegionPath } from "@/lib/files/image-region-path";
import type { FilePreviewInspector } from "@/types/thread";
import { askAboutImageRegion, RegionAskError, type RegionAskPorts } from "./image-region-ask";

const image = { isConnected: true } as unknown as HTMLImageElement;
const rect = { x: 10, y: 15, width: 20, height: 35 };
const source = {
  variant: "file",
  path: "results/plot.png",
  filename: "plot.png",
  root: "workspace",
  sha256: "abc123",
} as FilePreviewInspector;

function ports(overrides: Partial<RegionAskPorts> = {}): RegionAskPorts {
  return {
    isCurrent: () => true,
    snapshot: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    upload: vi.fn(async () => undefined),
    addReference: vi.fn(),
    finish: vi.fn(),
    ...overrides,
  };
}

describe("askAboutImageRegion", () => {
  it("snapshots, uploads under an image-region path, then references it", async () => {
    const calls: string[] = [];
    let uploaded: { blob: Blob; path: string } | undefined;
    const target = ports({
      snapshot: vi.fn(async () => {
        calls.push("snapshot");
        return new Blob(["png"], { type: "image/png" });
      }),
      upload: vi.fn(async (blob, path) => {
        calls.push("upload");
        uploaded = { blob, path };
      }),
      addReference: vi.fn(() => calls.push("reference")),
      finish: vi.fn(() => calls.push("finish")),
    });
    await askAboutImageRegion({ image, rect, source }, target);
    expect(calls).toEqual(["snapshot", "upload", "reference", "finish"]);
    expect(uploaded?.blob.size).toBe(3);
    expect(uploaded && isImageRegionPath(uploaded.path)).toBe(true);
    expect(target.addReference).toHaveBeenCalledWith(
      uploaded?.path,
      "results/plot.png (sha256 abc123) [x=10, y=15, w=20, h=35 px]",
    );
  });

  it("marks a base-root source in the reference description", async () => {
    const target = ports();
    await askAboutImageRegion({ image, rect, source: { ...source, root: "base" } }, target);
    expect(target.addReference).toHaveBeenCalledWith(
      expect.any(String),
      "base/results/plot.png (sha256 abc123) [x=10, y=15, w=20, h=35 px]",
    );
  });

  it("does nothing when the route or session already changed", async () => {
    const target = ports({ isCurrent: () => false });
    await askAboutImageRegion({ image, rect, source }, target);
    expect(target.snapshot).not.toHaveBeenCalled();
    expect(target.upload).not.toHaveBeenCalled();
    expect(target.addReference).not.toHaveBeenCalled();
    expect(target.finish).not.toHaveBeenCalled();
  });

  it("does not upload when the route changes while the snapshot is taken", async () => {
    let current = true;
    const target = ports({
      isCurrent: () => current,
      snapshot: vi.fn(async () => {
        current = false;
        return new Blob(["png"]);
      }),
    });
    await askAboutImageRegion({ image, rect, source }, target);
    expect(target.upload).not.toHaveBeenCalled();
    expect(target.addReference).not.toHaveBeenCalled();
  });

  it("does not attach a reference when the session changes during the upload", async () => {
    let current = true;
    const target = ports({
      isCurrent: () => current,
      upload: vi.fn(async () => {
        current = false;
      }),
    });
    await askAboutImageRegion({ image, rect, source }, target);
    expect(target.upload).toHaveBeenCalledTimes(1);
    expect(target.addReference).not.toHaveBeenCalled();
    expect(target.finish).not.toHaveBeenCalled();
  });

  it.each([
    [new ApiError("region.png is too large", 413), "rejected", "region.png is too large"],
    [new ApiError("upload failed", 500), "unknown", "upload failed"],
    [new TypeError("Failed to fetch"), "network", "Failed to fetch"],
    [new Error("PNG encoding failed"), "unknown", "PNG encoding failed"],
  ])("classifies %s as %s", async (original, kind, message) => {
    const target = ports({ upload: vi.fn(async () => Promise.reject(original)) });
    await expect(askAboutImageRegion({ image, rect, source }, target)).rejects.toMatchObject({
      name: "RegionAskError",
      kind,
      message,
      original,
    });
  });

  it("keeps a RegionAskError intact", async () => {
    const original = new RegionAskError("network", "offline");
    const target = ports({ snapshot: vi.fn(async () => Promise.reject(original)) });
    await expect(askAboutImageRegion({ image, rect, source }, target)).rejects.toBe(original);
  });
});
