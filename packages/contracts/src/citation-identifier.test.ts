import { describe, expect, it } from "vitest";
import { identifierFromUrl, identifierUrl, maskNonProse, scanIdentifiers } from "./citation-identifier.js";

describe("scanIdentifiers", () => {
  it("stops a DOI at a numbered marker written straight after it", () => {
    expect(scanIdentifiers("Gain (10.1000/alpha[1]).").map((match) => [match.kind, match.id, match.start, match.end])).toEqual([["doi", "10.1000/alpha", 6, 19]]);
  });

  it("stops a DOI at Chinese punctuation", () => {
    expect(scanIdentifiers("方法见 10.1038/s41586-020-2649-2，另见 arXiv:1706.03762。").map((match) => match.requested_id)).toEqual([
      "10.1038/s41586-020-2649-2",
      "1706.03762",
    ]);
  });

  it("keeps the cited arXiv version and the version-less source key apart", () => {
    expect(scanIdentifiers("arXiv:2401.12345v2 and arXiv:2401.12345v1").map((match) => [match.id, match.requested_id, match.requested_version])).toEqual([
      ["2401.12345", "2401.12345v2", "2"],
      ["2401.12345", "2401.12345v1", "1"],
    ]);
  });

  it("drops a DOI suffix made only of punctuation", () => {
    expect(scanIdentifiers("broken 10.1234/. end")).toEqual([]);
  });

  it("trims a long run of trailing punctuation from a scanned identifier and a resolver link", () => {
    const punctuated = `10.1000/alpha${"!".repeat(20_000)}`;
    expect(scanIdentifiers(`See ${punctuated}.`).map((match) => match.id)).toEqual(["10.1000/alpha"]);
    expect(identifierFromUrl(`https://doi.org/${punctuated}`)).toMatchObject({ id: "10.1000/alpha" });
  });
});

describe("scanIdentifiers label_start", () => {
  const labelOf = (text: string) => scanIdentifiers(text).map((match) => text.slice(match.label_start, match.end));

  it("absorbs a doi: scheme written straight before the identifier", () => {
    expect(labelOf("Our method follows doi:10.1038/s41586-021-03819-2 closely.")).toEqual(["doi:10.1038/s41586-021-03819-2"]);
  });

  it("absorbs the scheme in any case and with spaces around the colon", () => {
    expect(labelOf("See DOI:10.1000/a and DoI : 10.1000/b.")).toEqual(["DOI:10.1000/a", "DoI : 10.1000/b"]);
  });

  it("absorbs the scheme when Chinese prose is glued to it", () => {
    const text = "该结论见doi:10.1000/a，另见（doi:10.1000/b）。";
    expect(labelOf(text)).toEqual(["doi:10.1000/a", "doi:10.1000/b"]);
    expect(text.slice(0, scanIdentifiers(text)[0]!.label_start)).toBe("该结论见");
  });

  it("absorbs the scheme inside brackets and before a numbered marker", () => {
    expect(labelOf("(doi:10.1000/a)[2] and doi:10.1000/b[3]")).toEqual(["doi:10.1000/a", "doi:10.1000/b"]);
  });

  it("leaves a word that only ends in doi alone", () => {
    const text = "xdoi:10.1000/a";
    expect(labelOf(text)).toEqual(["10.1000/a"]);
    expect(scanIdentifiers(text)[0]!.label_start).toBe(5);
  });

  it("keeps a bare identifier's label on the identifier", () => {
    expect(labelOf("See 10.1000/a.")).toEqual(["10.1000/a"]);
  });

  it("leaves the arXiv scheme inside the match it already wrote", () => {
    const text = "See arXiv:2401.12345v2.";
    expect(labelOf(text)).toEqual(["arXiv:2401.12345v2"]);
    expect(scanIdentifiers(text)[0]!.label_start).toBe(scanIdentifiers(text)[0]!.start);
  });

  it("does not reach across prose to a scheme written somewhere else", () => {
    const text = "Prose `doi:` is not a scheme, 10.1000/a stands alone.";
    expect(labelOf(text)).toEqual(["10.1000/a"]);
  });

  it("keeps start on the identifier itself so a marker still lands after it", () => {
    const text = "see doi:10.1000/a now";
    const match = scanIdentifiers(text)[0]!;
    expect([match.start, match.end]).toEqual([8, 17]);
    expect(text.slice(match.start, match.end)).toBe("10.1000/a");
  });
});

describe("maskNonProse", () => {
  it("blanks fenced code, inline code and math without moving any offset", () => {
    const text = "Prose 10.1000/real.\n\n```\n10.1000/fenced\n```\n\nInline `10.1000/inline`.\n\nMath $10.1000/math$.";
    const masked = maskNonProse(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n").filter((line) => line.trim()).join("\n")).not.toContain("10.1000/fenced");
    expect(scanIdentifiers(text).map((match) => match.id)).toEqual(["10.1000/real"]);
  });
});

describe("identifierFromUrl", () => {
  it("reads a DOI resolver link", () => {
    expect(identifierFromUrl("https://doi.org/10.1000/Alpha")).toEqual({ kind: "doi", id: "10.1000/alpha", requested_id: "10.1000/alpha", requested_version: null });
    expect(identifierFromUrl("https://dx.doi.org/10.1000/alpha")).toMatchObject({ kind: "doi", id: "10.1000/alpha" });
  });

  it("reads an arXiv abs or pdf link with its version", () => {
    expect(identifierFromUrl("https://arxiv.org/abs/2401.12345v2")).toEqual({ kind: "arxiv", id: "2401.12345", requested_id: "2401.12345v2", requested_version: "2" });
    expect(identifierFromUrl("https://arxiv.org/pdf/2401.12345")).toMatchObject({ kind: "arxiv", id: "2401.12345", requested_id: "2401.12345" });
  });

  it("reads nothing from a link that names no source", () => {
    expect(identifierFromUrl("https://example.org/paper")).toBeNull();
    expect(identifierFromUrl("https://doi.org/")).toBeNull();
  });
});

describe("identifierUrl", () => {
  it("resolves each kind to the record a reader can open", () => {
    expect(identifierUrl("doi", "10.1000/alpha")).toBe("https://doi.org/10.1000/alpha");
    expect(identifierUrl("arxiv", "2401.12345v2")).toBe("https://arxiv.org/abs/2401.12345v2");
  });
});
