import { describe, expect, it } from "vitest";
import { claimAround, MAX_CLAIM_CHARS } from "./citation-claim";

describe("claimAround", () => {
  it("takes the sentence the marker sits in, not the paragraph", () => {
    const text = "The first claim is old. AlphaFold reached near-experimental accuracy , and that is what we cite. A third sentence follows.";
    const offset = text.indexOf("near-experimental");
    expect(claimAround(text, offset)).toBe("AlphaFold reached near-experimental accuracy , and that is what we cite.");
  });

  it("ends a Chinese sentence at Chinese punctuation", () => {
    const text = "第一句是背景。AlphaFold 达到了接近实验的精度，这是我们引用的地方。第三句在后面。";
    expect(claimAround(text, text.indexOf("AlphaFold"))).toBe("AlphaFold 达到了接近实验的精度，这是我们引用的地方。");
  });

  it("does not end a sentence at a dot inside an identifier", () => {
    const text = "Reported in doi:10.1000/alpha, and again later. Next sentence.";
    expect(claimAround(text, text.indexOf("10.1000"))).toBe("Reported in doi:10.1000/alpha, and again later.");
  });

  it("stops at a blank line when the paragraph has no full stop", () => {
    const text = "Heading\n\nA line with no terminator at all , cited here\n\nNext block";
    expect(claimAround(text, text.indexOf("cited here"))).toBe("A line with no terminator at all , cited here");
  });

  it("keeps the marker's own neighbourhood when the sentence is longer than the cap", () => {
    const filler = "word ".repeat(400);
    const text = `${filler}the cited claim sits here${filler}`;
    const claim = claimAround(text, text.indexOf("the cited claim"));
    expect(claim.length).toBeLessThanOrEqual(MAX_CLAIM_CHARS);
    expect(claim).toContain("the cited claim sits here");
    expect(claim.endsWith("…")).toBe(true);
  });

  it("clamps an offset past the text instead of throwing", () => {
    expect(claimAround("Only one sentence.", 9_999)).toBe("Only one sentence.");
    expect(claimAround("Only one sentence.", -5)).toBe("Only one sentence.");
  });

  it("collapses whitespace so a claim is one line", () => {
    expect(claimAround("A claim\n   broken over lines.", 0)).toBe("A claim broken over lines.");
  });

  it("returns an empty claim for empty text", () => {
    expect(claimAround("", 0)).toBe("");
  });
});
