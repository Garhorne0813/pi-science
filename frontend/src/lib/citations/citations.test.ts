import { describe, expect, it } from "vitest";
import { extractCitations } from "./citations";

describe("extractCitations", () => {
  it("extracts a DOI with a doi.org url", () => {
    expect(extractCitations("See doi:10.1038/s41586-025-1234-5 for details."))
      .toEqual([{ kind: "doi", id: "10.1038/s41586-025-1234-5", url: "https://doi.org/10.1038/s41586-025-1234-5" }]);
  });

  it("normalizes DOIs by stripping trailing punctuation and lowercasing", () => {
    expect(extractCitations("Published as 10.1000/XYZ123."))
      .toEqual([{ kind: "doi", id: "10.1000/xyz123", url: "https://doi.org/10.1000/xyz123" }]);
    expect(extractCitations("(10.1234/abc),; end"))
      .toEqual([{ kind: "doi", id: "10.1234/abc", url: "https://doi.org/10.1234/abc" }]);
  });

  it("extracts arXiv identifiers, case-insensitively and with optional space", () => {
    expect(extractCitations("Compare arXiv:2401.12345v2 with arxiv: 1706.03762."))
      .toEqual([
        { kind: "arxiv", id: "2401.12345v2", url: "https://arxiv.org/abs/2401.12345v2" },
        { kind: "arxiv", id: "1706.03762", url: "https://arxiv.org/abs/1706.03762" },
      ]);
  });

  it("dedupes repeats and preserves first-seen order across kinds", () => {
    const text = "arXiv:2107.03374 then 10.1000/first then doi:10.1000/FIRST and arXiv:2107.03374 again.\n\n## References\n1. doi:10.1000/first\n2. arXiv:2107.03374";
    expect(extractCitations(text)).toEqual([
      { kind: "arxiv", id: "2107.03374", url: "https://arxiv.org/abs/2107.03374" },
      { kind: "doi", id: "10.1000/first", url: "https://doi.org/10.1000/first" },
    ]);
  });

  it("ignores plain text and DOIs whose suffix is only punctuation", () => {
    expect(extractCitations("No identifiers here, just 10 items and pi.")).toEqual([]);
    expect(extractCitations("Broken ref 10.1234/. end")).toEqual([]);
  });
});
