import { afterEach, describe, expect, it, vi } from "vitest";
import { injectWorkspaceReferences, referencesFromMessage } from "./file-references";
import { imageRegionId, imageRegionPath, isImageRegionPath } from "./image-region-path";

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
/** An id minted by `crypto.randomUUID` before the generator moved here. */
const RANDOM_UUID_ID = "fbaf434f-c2d8-4343-885a-e36ee1591629";

afterEach(() => vi.unstubAllGlobals());

describe("image region paths", () => {
  it("mints distinct v4-shaped ids without crypto.randomUUID", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: original.getRandomValues.bind(original) });
    const ids = Array.from({ length: 64 }, imageRegionId);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("agrees with the reference parser for a freshly generated path", () => {
    const path = imageRegionPath();
    expect(isImageRegionPath(path)).toBe(true);
    expect(path).toMatch(/^image-regions\/[\da-f-]{36}\.png$/);
    const message = injectWorkspaceReferences("What is in this region?", [
      {
        cwd: "/workspace/study",
        path,
        name: "plot.png",
        isDir: false,
        imageRegion: "results/plot.png [x=1, y=2, w=3, h=4 px]",
      },
    ]);
    expect(referencesFromMessage(message)).toEqual([
      {
        path,
        name: path.slice("image-regions/".length),
        isDir: false,
        imageRegion: "results/plot.png [x=1, y=2, w=3, h=4 px]",
      },
    ]);
  });

  it("keeps ids minted by crypto.randomUUID parseable", () => {
    expect(isImageRegionPath(`image-regions/${RANDOM_UUID_ID}.png`)).toBe(true);
  });

  it("rejects paths outside the upload shape", () => {
    const rejected = [
      "image-regions/plot.png",
      "image-regions/nested/plot.png",
      `plots/${RANDOM_UUID_ID}.png`,
      `image-regions/${RANDOM_UUID_ID}.jpg`,
      `image-regions/${RANDOM_UUID_ID}x.png`,
    ];
    for (const path of rejected) {
      expect(isImageRegionPath(path)).toBe(false);
      expect(referencesFromMessage(`<workspace_references>\n- image-region (read this PNG for the marked overview above and detail below): ${JSON.stringify([path, "x"])}\n</workspace_references>`)).toEqual([]);
    }
  });

  it("accepts exactly one directory and one uuid file, nothing longer", () => {
    const region = `image-regions/${RANDOM_UUID_ID}.png`;
    expect(isImageRegionPath(region)).toBe(true);
    const rejected = [
      `${region}/evil`,
      "image-regions/../../x",
      `/${region}`,
    ];
    for (const path of rejected) {
      expect(isImageRegionPath(path)).toBe(false);
      expect(referencesFromMessage(`<workspace_references>\n- image-region (read this PNG for the marked overview above and detail below): ${JSON.stringify([path, "x"])}\n</workspace_references>`)).toEqual([]);
    }
  });
});
