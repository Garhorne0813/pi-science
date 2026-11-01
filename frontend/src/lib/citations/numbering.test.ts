import { describe, expect, it } from "vitest";
import { citationNumberOf, numberCitations, referencesText, withReferences } from "./numbering";

describe("numberCitations", () => {
  it("numbers by first citation and reuses a number for a source cited again", () => {
    const numbering = numberCitations("First 10.1000/alpha, then 10.1000/alpha again, then 10.1000/beta.");
    expect(numbering.sources.map((source) => [source.number, source.id])).toEqual([
      [1, "10.1000/alpha"],
      [2, "10.1000/beta"],
    ]);
  });

  it("reads as [1], [1], [2] in the document", () => {
    const text = "Result A 10.1000/alpha. Result B 10.1000/alpha. Result C 10.1000/beta.";
    const numbering = numberCitations(text);
    const markers = [...text.matchAll(/10\.1000\/[a-z]+/g)].map((match) => citationNumberOf(numbering, "doi", match[0]));
    expect(markers).toEqual([1, 1, 2]);
  });

  it("gives two versions of one answer independent numbering", () => {
    const first = numberCitations("Beta 10.1000/beta then alpha 10.1000/alpha.");
    const second = numberCitations("Alpha 10.1000/alpha then beta 10.1000/beta.");
    expect(citationNumberOf(first, "doi", "10.1000/beta")).toBe(1);
    expect(citationNumberOf(second, "doi", "10.1000/beta")).toBe(2);
    expect(citationNumberOf(second, "doi", "10.1000/alpha")).toBe(1);
  });

  it("keeps every cited spelling of one source and the first version", () => {
    const numbering = numberCitations("Earlier arXiv:2401.12345v2, later arXiv:2401.12345v1.");
    expect(numbering.sources).toHaveLength(1);
    expect(numbering.sources[0]).toMatchObject({ number: 1, id: "2401.12345", requested_ids: ["2401.12345v2", "2401.12345v1"], requested_version: "2" });
  });

  it("does not number an identifier that only appears in code or math", () => {
    const text = [
      "Prose cites 10.1000/real.",
      "",
      "```",
      "10.1000/fenced",
      "```",
      "",
      "Inline `10.1000/inline` stays code.",
      "",
      "Math $10.1000/math$ stays math.",
    ].join("\n");
    expect(numberCitations(text).sources.map((source) => source.id)).toEqual(["10.1000/real"]);
  });

  it("leaves an existing numbered reference list alone", () => {
    const text = "Body [1].\n\n## References\n1. 10.1000/alpha";
    const numbering = numberCitations(text);
    expect(numbering.sources.map((source) => source.id)).toEqual(["10.1000/alpha"]);
    expect(withReferences(text)).toBe("Body [1].\n\n## References\n[1] 10.1000/alpha — https://doi.org/10.1000/alpha\n");
  });

  it("terminates a DOI at Chinese punctuation", () => {
    const numbering = numberCitations("AlphaFold 方法见 10.1038/s41586-020-2649-2，另见 arXiv:1706.03762。");
    expect(numbering.sources.map((source) => `${source.number}:${source.kind}:${source.id}`)).toEqual([
      "1:doi:10.1038/s41586-020-2649-2",
      "2:arxiv:1706.03762",
    ]);
  });
});

describe("referencesText", () => {
  it("uses the looked-up fields and omits the ones nobody looked up", () => {
    const numbering = numberCitations("10.1000/alpha and 10.1000/beta");
    const details = new Map([[1, { title: "A title", authors: ["Kojima S", "Teshima K"], year: "2009", venue: "JACS" }]]);
    expect(referencesText(numbering, { details, heading: "参考文献" }).split("\n")).toEqual([
      "## 参考文献",
      "[1] Kojima S, Teshima K (2009). A title. JACS. 10.1000/alpha — https://doi.org/10.1000/alpha",
      "[2] 10.1000/beta — https://doi.org/10.1000/beta",
    ]);
  });

  it("never invents a title for a source it knows nothing about", () => {
    const numbering = numberCitations("10.1000/alpha");
    expect(referencesText(numbering)).not.toMatch(/A title|undefined|null/);
  });
});

describe("withReferences", () => {
  it("marks the body and appends the list a reader can trace", () => {
    const out = withReferences("Report body citing 10.1000/alpha and 10.1000/beta.");
    expect(out).toContain("Report body citing 10.1000/alpha[1] and 10.1000/beta[2].");
    expect(out).toContain("## References");
    expect(out).toContain("[1] 10.1000/alpha — https://doi.org/10.1000/alpha");
    expect(out).toContain("[2] 10.1000/beta — https://doi.org/10.1000/beta");
  });

  it("is idempotent, so a written report is not marked twice", () => {
    const once = withReferences("Body 10.1000/alpha.");
    expect(withReferences(once)).toBe(once);
  });

  it("does not read its own marker back as part of the identifier", () => {
    expect(withReferences("Body 10.1000/alpha.").split("\n")[0]).toBe("Body 10.1000/alpha[1].");
    expect(numberCitations("Body 10.1000/alpha[1].").sources.map((source) => source.id)).toEqual(["10.1000/alpha"]);
  });

  it("numbers a report file that already carries a bare-identifier reference list", () => {
    const drafted = [
      "Retrieval augmented generation reports a gain on open-domain QA (10.1000/alpha).",
      "",
      "## References",
      "1. Kojima et al. (2009). A title. JACS. https://doi.org/10.1000/alpha",
    ].join("\n");
    const out = withReferences(drafted, { details: new Map([[1, { title: "A title", authors: ["Kojima S"], year: "2009", venue: "JACS" }]]) });
    expect(out).toContain("open-domain QA (10.1000/alpha)[1].");
    expect(out.split("## References")).toHaveLength(2);
    expect(out).toContain("[1] Kojima S (2009). A title. JACS. 10.1000/alpha — https://doi.org/10.1000/alpha");
    expect(withReferences(out, { details: new Map([[1, { title: "A title", authors: ["Kojima S"], year: "2009", venue: "JACS" }]]) })).toBe(out);
  });

  it("returns a document with no citations untouched", () => {
    expect(withReferences("Nothing to cite here.")).toBe("Nothing to cite here.");
  });
});
