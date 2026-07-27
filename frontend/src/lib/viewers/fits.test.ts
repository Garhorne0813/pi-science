import { describe, expect, it } from "vitest";
import { parseFits, pixelToWorld } from "./fits";

const BLOCK = 2880;
const CARD = 80;

function fitsCard(key: string, value?: string): string {
  const body = value === undefined ? key : `${key.padEnd(8)}= ${value}`;
  return body.padEnd(CARD, " ").slice(0, CARD);
}

/** Build a standards-shaped primary HDU: 2880-byte header blocks, big-endian data. */
function imageFixture(): ArrayBuffer {
  const cards = [
    fitsCard("SIMPLE", "T"),
    fitsCard("BITPIX", "16"),
    fitsCard("NAXIS", "2"),
    fitsCard("NAXIS1", "2"),
    fitsCard("NAXIS2", "2"),
    fitsCard("BZERO", "10"),
    fitsCard("BSCALE", "2"),
    fitsCard("BLANK", "-32768"),
    fitsCard("OBJECT", "'A10 sample'"),
    fitsCard("BUNIT", "'adu'"),
    fitsCard("CTYPE1", "'RA---TAN'"),
    fitsCard("CTYPE2", "'DEC--TAN'"),
    fitsCard("CRVAL1", "180"),
    fitsCard("CRVAL2", "45"),
    fitsCard("CRPIX1", "1"),
    fitsCard("CRPIX2", "1"),
    fitsCard("CDELT1", "-0.1"),
    fitsCard("CDELT2", "0.2"),
    fitsCard("END"),
  ];
  const header = new TextEncoder().encode(cards.join("").padEnd(BLOCK, " "));
  const buffer = new ArrayBuffer(BLOCK * 2);
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer, BLOCK);
  [1, 2, -32768, 4].forEach((value, index) => view.setInt16(index * 2, value, false));
  return buffer;
}

describe("parseFits", () => {
  it("parses a real FITS primary-image layout, scaling pixels and preserving BLANK", () => {
    const result = parseFits(imageFixture());
    expect(result.kind).toBe("image");
    if (result.kind !== "image") throw new Error("expected an image HDU");
    expect([result.width, result.height]).toEqual([2, 2]);
    expect([...result.data.slice(0, 2)]).toEqual([12, 14]);
    expect(Number.isNaN(result.data[2])).toBe(true);
    expect(result.data[3]).toBe(18);
    expect(result.object).toBe("A10 sample");
    expect(result.bunit).toBe("adu");
    expect(result.wcs.ctype1).toBe("RA---TAN");
  });

  it("converts zero-based image pixels through the linear FITS WCS", () => {
    const result = parseFits(imageFixture());
    if (result.kind !== "image") throw new Error("expected an image HDU");
    expect(pixelToWorld(result.wcs, 0, 0)).toEqual({ lon: 180, lat: 45 });
    const next = pixelToWorld(result.wcs, 1, 1);
    expect(next?.lat).toBeCloseTo(45.2, 10);
    expect(next?.lon).toBeLessThan(180);
    expect(pixelToWorld({}, 0, 0)).toBeNull();
  });

  it("rejects non-FITS input and headers without data", () => {
    expect(() => parseFits(new TextEncoder().encode("not fits").buffer)).toThrow(/missing SIMPLE/);
    const headerOnly = new TextEncoder().encode(
      [fitsCard("SIMPLE", "T"), fitsCard("BITPIX", "8"), fitsCard("NAXIS", "0"), fitsCard("END")]
        .join("")
        .padEnd(BLOCK, " "),
    ).buffer;
    expect(() => parseFits(headerOnly)).toThrow(/NAXIS=0/);
  });
});
