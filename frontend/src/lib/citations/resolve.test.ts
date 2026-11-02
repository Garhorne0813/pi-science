import { describe, expect, it } from "vitest";
import type { CitationSource } from "@pi-science/contracts";
import { citationSourceContentVisible, resolveCitations } from "./resolve";

function source(overrides: Partial<CitationSource> & Pick<CitationSource, "kind" | "identity">): CitationSource {
  return {
    id: `${overrides.kind}:${overrides.identity}`,
    title: overrides.identity,
    locator: { kind: "whole-source" },
    excerpt: null,
    capturedAt: null,
    evidence: { tool: overrides.kind === "web" ? "web_fetch" : "read", callId: "call-1", turnId: null },
    status: "verified",
    statusDetail: null,
    ...overrides,
  };
}

describe("resolveCitations", () => {
  it("resolves a DOI plus captured file and web sources in text order", () => {
    const text = "See 10.1000/abc, then results/table.csv, and https://example.org/report for context.";
    const resolved = resolveCitations(text, [
      source({ kind: "web", identity: "https://example.org/report" }),
      source({ kind: "file", identity: "results/table.csv" }),
    ]);
    expect(resolved.map((citation) => [citation.index, citation.token.kind, citation.token.identity])).toEqual([
      [1, "doi", "10.1000/abc"],
      [2, "file", "results/table.csv"],
      [3, "web", "https://example.org/report"],
    ]);
    expect(resolved[0]?.source).toBeNull();
    expect(resolved[1]?.source?.kind).toBe("file");
  });

  it("never cites a path or URL the server did not capture", () => {
    const text = "Read secrets/id_rsa and https://evil.example/x, plus results/real.csv.";
    const resolved = resolveCitations(text, [source({ kind: "file", identity: "results/real.csv" })]);
    expect(resolved.map((citation) => citation.token.identity)).toEqual(["results/real.csv"]);
    expect(resolveCitations("nothing here", [source({ kind: "file", identity: "results/real.csv" })])).toEqual([]);
  });

  it("counts a repeated source once at its first position", () => {
    const text = "results/a.csv again results/a.csv";
    const resolved = resolveCitations(text, [source({ kind: "file", identity: "results/a.csv" })]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ index: 1, token: { start: 0 } });
  });

  it("prefers a DOI identifier when a captured path starts at the same offset", () => {
    const resolved = resolveCitations("10.1234/xyz", [source({ kind: "file", identity: "10.1234/xyz" })]);
    expect(resolved.map((citation) => citation.token.kind)).toEqual(["doi"]);
  });

  it("matches a page URL whose normalized form adds a trailing slash", () => {
    const resolved = resolveCitations("See https://example.org for details.", [source({ kind: "web", identity: "https://example.org/", title: "example.org" })]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ token: { identity: "https://example.org/", start: 4, end: 23 } });
  });

  it("never lets a shorter url claim a longer one the answer wrote", () => {
    const home = source({ kind: "web", identity: "https://example.org/", title: "example.org" });
    expect(resolveCitations("See https://example.org/another-paper for the data.", [home])).toEqual([]);
    expect(resolveCitations("See https://example.org/ for the home page.", [home])).toHaveLength(1);
  });

  it("never lets a path claim a longer name that starts with it", () => {
    const report = source({ kind: "file", identity: "report.md" });
    expect(resolveCitations("The backup is report.md.bak.", [report])).toEqual([]);
    expect(resolveCitations("The copy is data/report.md, not this one.", [report])).toEqual([]);
    expect(resolveCitations("Read report.md for the numbers.", [report])).toHaveLength(1);
  });

  it("matches a path or url the answer wrapped in punctuation", () => {
    const report = source({ kind: "file", identity: "report.md" });
    const page = source({ kind: "web", identity: "https://example.org/page", title: "example.org" });
    const text = "Read (`report.md`) and [the page](https://example.org/page), then report.md.";
    const resolved = resolveCitations(text, [report, page]);
    expect(resolved.map((citation) => [citation.token.kind, citation.token.identity, citation.token.start])).toEqual([
      ["file", "report.md", 7],
      ["web", "https://example.org/page", 34],
    ]);
  });

  it("compares the url the registry stores with the raw one the answer wrote", () => {
    expect(resolveCitations("See https://EXAMPLE.org/report#results.", [source({ kind: "web", identity: "https://example.org/report" })])).toHaveLength(1);
    expect(resolveCitations("./report.md", [source({ kind: "file", identity: "report.md" })])).toHaveLength(1);
  });

  it("only offers content for a source the server could still read", () => {
    expect(citationSourceContentVisible(source({ kind: "file", identity: "a.csv" }))).toBe(true);
    expect(citationSourceContentVisible(source({ kind: "file", identity: "a.csv", status: "missing" }))).toBe(true);
    expect(citationSourceContentVisible(source({ kind: "file", identity: "a.csv", status: "forbidden" }))).toBe(false);
    expect(citationSourceContentVisible(source({ kind: "doi", identity: "10.1000/x", status: "identifier-only" }))).toBe(false);
    expect(citationSourceContentVisible(null)).toBe(false);
  });

  it("keeps arXiv identifiers and numbers them after the previous citation", () => {
    const text = "Compare arXiv:2401.12345 with results/b.csv.";
    const resolved = resolveCitations(text, [source({ kind: "file", identity: "results/b.csv" })]);
    expect(resolved.map((citation) => [citation.index, citation.token.kind])).toEqual([[1, "arxiv"], [2, "file"]]);
  });
});
