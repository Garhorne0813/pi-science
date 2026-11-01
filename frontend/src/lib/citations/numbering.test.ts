import { describe, expect, it } from "vitest";
import { citationNumberOf, numberCitations, referenceSections, referencesText, withReferences } from "./numbering";

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

  it("numbers two arXiv versions of one paper separately, each with its own resolver", () => {
    const numbering = numberCitations("First arXiv:2401.12345v1, later arXiv:2401.12345v2.");
    expect(numbering.sources.map((source) => [source.number, source.id, source.requested_ids[0], source.url])).toEqual([
      [1, "2401.12345", "2401.12345v1", "https://arxiv.org/abs/2401.12345v1"],
      [2, "2401.12345", "2401.12345v2", "https://arxiv.org/abs/2401.12345v2"],
    ]);
  });

  it("keeps both spellings visible when one version is cited twice", () => {
    const numbering = numberCitations("arXiv:2401.12345v1 once, arXiv:2401.12345v1 twice, arXiv:2401.12345v2 later.");
    expect(numbering.sources.map((source) => source.requested_ids)).toEqual([["2401.12345v1"], ["2401.12345v2"]]);
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

  it("terminates a DOI at Chinese punctuation", () => {
    const numbering = numberCitations("AlphaFold 方法见 10.1038/s41586-020-2649-2，另见 arXiv:1706.03762。");
    expect(numbering.sources.map((source) => `${source.number}:${source.kind}:${source.id}`)).toEqual([
      "1:doi:10.1038/s41586-020-2649-2",
      "2:arxiv:1706.03762",
    ]);
  });
});

describe("referenceSections", () => {
  it("finds an English and a Chinese list and stops at the next section", () => {
    const text = "Body.\n\n## References\n1. alpha\n\n## Limitations\nSmall sample.";
    expect(referenceSections(text)).toHaveLength(1);
    const [section] = referenceSections(text);
    expect(text.slice(section!.start, section!.start + 12)).toBe("## Reference");
    expect(text.slice(section!.end, section!.end + 14)).toBe("## Limitations");
  });

  it("reads a Chinese heading as a reference list", () => {
    expect(referenceSections("正文。\n\n## 参考文献\n1. 张三")).toHaveLength(1);
  });

  it("lets a nested heading stay inside the list", () => {
    const text = "Body.\n\n# References\n### Journal articles\n1. alpha";
    const [section] = referenceSections(text);
    expect(section!.end).toBe(text.length);
  });
});

describe("reference-only sources", () => {
  it("gives no body number to a source the body never cites", () => {
    const text = "Body with no identifier.\n\n## References\n1. Smith (2020). A title. https://doi.org/10.1000/gamma";
    expect(numberCitations(text).sources).toEqual([]);
    expect(withReferences(text)).toBe(text);
  });

  it("still uses a source the body cites before the list", () => {
    const text = "Body cites 10.1000/alpha.\n\n## References\n1. Smith (2020). A title. https://doi.org/10.1000/alpha";
    expect(numberCitations(text).sources.map((source) => source.number)).toEqual([1]);
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

  it("prints volume, issue and pages only when they were looked up", () => {
    const numbering = numberCitations("10.1000/alpha and 10.1000/beta");
    const details = new Map([
      [1, { title: "A title", venue: "JACS", volume: "131", issue: "5", pages: "1742-1751" }],
      [2, { title: "Another title", venue: "Nature", volume: "600" }],
    ]);
    expect(referencesText(numbering, { details }).split("\n").slice(1)).toEqual([
      "[1] A title. JACS. 131(5): 1742-1751. 10.1000/alpha — https://doi.org/10.1000/alpha",
      "[2] Another title. Nature. 600. 10.1000/beta — https://doi.org/10.1000/beta",
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

  it("returns a document with no citations untouched", () => {
    expect(withReferences("Nothing to cite here.")).toBe("Nothing to cite here.");
  });

  it("keeps the authors, title and year an existing English list wrote, and the sections after it", () => {
    const drafted = [
      "Retrieval augmented generation reports a gain (10.1000/alpha).",
      "",
      "## References",
      "1. Kojima, S., Teshima, K. (2009). A title. JACS. https://doi.org/10.1000/alpha",
      "",
      "## Limitations",
      "The sample is small, and 10.1000/beta is only mentioned here.",
    ].join("\n");
    const out = withReferences(drafted);
    expect(out).toBe([
      "Retrieval augmented generation reports a gain (10.1000/alpha)[1].",
      "",
      "## References",
      "[1] Kojima, S., Teshima, K. (2009). A title. JACS. https://doi.org/10.1000/alpha",
      "[2] 10.1000/beta — https://doi.org/10.1000/beta",
      "",
      "## Limitations",
      "The sample is small, and 10.1000/beta[2] is only mentioned here.",
    ].join("\n"));
  });

  it("numbers a Chinese list once instead of appending a second one", () => {
    const drafted = ["正文引用 10.1000/alpha。", "", "## 参考文献", "1. 张三 (2020). 标题. 期刊. https://doi.org/10.1000/alpha", "", "## 附录", "附录说明。"].join("\n");
    const out = withReferences(drafted);
    expect(out.split("## 参考文献")).toHaveLength(2);
    expect(out).toBe([
      "正文引用 10.1000/alpha[1]。",
      "",
      "## 参考文献",
      "[1] 张三 (2020). 标题. 期刊. https://doi.org/10.1000/alpha",
      "",
      "## 附录",
      "附录说明。",
    ].join("\n"));
  });

  it("appends the one entry an existing list forgot without touching its other lines", () => {
    const drafted = ["Body 10.1000/alpha.", "", "## References", "1. A title. https://doi.org/10.1000/alpha", "2. A note that names no source."].join("\n");
    expect(withReferences(drafted).split("\n").slice(2)).toEqual([
      "## References",
      "[1] A title. https://doi.org/10.1000/alpha",
      "2. A note that names no source.",
    ]);
    expect(withReferences(["Body 10.1000/alpha and 10.1000/beta.", "", "## References", "1. A title. https://doi.org/10.1000/alpha"].join("\n")).split("\n").slice(2)).toEqual([
      "## References",
      "[1] A title. https://doi.org/10.1000/alpha",
      "[2] 10.1000/beta — https://doi.org/10.1000/beta",
    ]);
  });

  it("numbers a report file that already carries a bare-identifier reference list", () => {
    const drafted = [
      "Retrieval augmented generation reports a gain on open-domain QA (10.1000/alpha).",
      "",
      "## References",
      "1. Kojima et al. (2009). A title. JACS. https://doi.org/10.1000/alpha",
    ].join("\n");
    const out = withReferences(drafted);
    expect(out).toContain("open-domain QA (10.1000/alpha)[1].");
    expect(out.split("## References")).toHaveLength(2);
    expect(out).toContain("[1] Kojima et al. (2009). A title. JACS. https://doi.org/10.1000/alpha");
    expect(withReferences(out)).toBe(out);
  });

  it("leaves an existing list alone when the body carries no identifier", () => {
    const text = "Body [1].\n\n## References\n1. 10.1000/alpha";
    expect(withReferences(text)).toBe(text);
  });
});
