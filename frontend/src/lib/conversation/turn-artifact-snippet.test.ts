import { describe, expect, it } from "vitest";
import { codeSnippet, markdownSnippet, parseCsvSnippet, parseTsvSnippet, splitDelimitedLine } from "./turn-artifact-snippet";

describe("splitDelimitedLine", () => {
  it("splits on the separator and keeps empty fields", () => {
    expect(splitDelimitedLine("a,b,,d", ",")).toEqual(["a", "b", "", "d"]);
  });

  it("keeps separators inside double-quoted fields and unescapes doubled quotes", () => {
    expect(splitDelimitedLine('a,"b,c",d', ",")).toEqual(["a", "b,c", "d"]);
    expect(splitDelimitedLine('"he said ""hi""",x', ",")).toEqual(['he said "hi"', "x"]);
  });
});

describe("parseCsvSnippet", () => {
  it("parses header plus up to 3 data rows", () => {
    const out = parseCsvSnippet("gene,value,pval\nA,1.0,0.01\nB,2.0,0.02\nC,3.0,0.03\nD,4.0,0.04\nE,5.0,0.05");
    expect(out.columns).toEqual(["gene", "value", "pval"]);
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toEqual(["A", "1.0", "0.01"]);
    expect(out.truncated).toBe(true);
  });

  it("caps columns at 5", () => {
    const out = parseCsvSnippet("a,b,c,d,e,f,g\n1,2,3,4,5,6,7");
    expect(out.columns).toHaveLength(5);
    expect(out.rows[0]).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("handles quoted fields containing commas", () => {
    const out = parseCsvSnippet('id,label\n1,"x, y"');
    expect(out.rows[0]).toEqual(["1", "x, y"]);
  });

  it("is not truncated when rows fit", () => {
    const out = parseCsvSnippet("a,b\n1,2");
    expect(out.truncated).toBe(false);
  });
});

describe("parseTsvSnippet", () => {
  it("splits on tabs", () => {
    const out = parseTsvSnippet("col1\tcol2\n1\t2\n3\t4");
    expect(out.columns).toEqual(["col1", "col2"]);
    expect(out.rows).toEqual([["1", "2"], ["3", "4"]]);
  });
});

describe("codeSnippet", () => {
  it("returns the first 8 lines and reports truncation", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    const out = codeSnippet(lines.join("\n"));
    expect(out.code.split("\n")).toHaveLength(8);
    expect(out.code.startsWith("line 0")).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it("returns everything when it fits", () => {
    const out = codeSnippet("a\nb");
    expect(out.code).toBe("a\nb");
    expect(out.truncated).toBe(false);
  });
});

describe("markdownSnippet", () => {
  it("cuts at a word boundary under the cap and reports truncation", () => {
    const long = "word ".repeat(60).trim();
    const out = markdownSnippet(long);
    expect(out.markdown.length).toBeLessThanOrEqual(200);
    expect(out.markdown.endsWith("word")).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it("returns the whole text when short", () => {
    const out = markdownSnippet("# Title\n\nShort body.");
    expect(out.markdown).toBe("# Title\n\nShort body.");
    expect(out.truncated).toBe(false);
  });
});
