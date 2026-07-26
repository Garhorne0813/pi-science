import { describe, expect, it } from "vitest";
import { parseQCode, segmentsFor } from "./qcode";

const INTERVIEW = JSON.stringify({
  sources: [{ id: "s1", title: "Interview 1", text: "Open data improves trust." }],
  codes: [{ name: "openness" }, { name: "trust" }],
  annotations: [
    { source: "s1", code: "openness", start: 0, end: 9 },
    { source: "s1", code: "trust", start: 5, end: 24, memo: "overlapping evidence" },
    { source: "missing", code: "trust", start: 0, end: 4 },
    { source: "s1", code: "unknown", start: 25, end: 30 },
  ],
});

describe("qualitative coding parser", () => {
  it("preserves exact source quotes, counts valid spans, and reports bad references", () => {
    const doc = parseQCode(INTERVIEW);
    expect(doc.quoteOf(doc.annotations[0])).toBe("Open data");
    expect(doc.countByCode).toEqual({ openness: 1, trust: 1 });
    expect(doc.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("unknown source"),
      expect.stringContaining("out-of-range span"),
    ]));
  });

  it("segments overlapping annotations without losing either code", () => {
    const doc = parseQCode(INTERVIEW);
    expect(segmentsFor(doc, "s1")).toEqual([
      { text: "Open ", start: 0, end: 5, codes: ["openness"] },
      { text: "data", start: 5, end: 9, codes: ["openness", "trust"] },
      { text: " improves trust", start: 9, end: 24, codes: ["trust"] },
      { text: ".", start: 24, end: 25, codes: [] },
    ]);
  });

  it("rejects malformed documents instead of fabricating empty data", () => {
    expect(() => parseQCode("not json")).toThrow(/not valid JSON/);
    expect(() => parseQCode(JSON.stringify({ sources: [] }))).toThrow(/no sources/);
    expect(segmentsFor({ sources: [], codes: [], annotations: [] }, "missing")).toEqual([]);
  });
});
