import { describe, expect, it } from "vitest";
import { citationLocatorSchema, citationSourceSchema, citationSourcesResponseSchema } from "./citations.js";

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "file:results/table.csv",
    kind: "file",
    identity: "results/table.csv",
    title: "table.csv",
    locator: { kind: "whole-source" },
    excerpt: null,
    capturedAt: null,
    evidence: null,
    status: "identifier-only",
    statusDetail: null,
    ...overrides,
  };
}

describe("citation sources contract", () => {
  it("accepts every locator shape and every source status", () => {
    expect(citationLocatorSchema.parse({ kind: "lines", startLine: 2, endLine: 7 })).toEqual({ kind: "lines", startLine: 2, endLine: 7 });
    expect(citationLocatorSchema.parse({ kind: "chars", start: 0, end: 12 })).toEqual({ kind: "chars", start: 0, end: 12 });
    expect(citationLocatorSchema.parse({ kind: "whole-source" })).toEqual({ kind: "whole-source" });
    for (const status of ["verified", "changed", "missing", "forbidden", "unavailable", "identifier-only"]) {
      expect(citationSourceSchema.parse(source({ status }))).toMatchObject({ status });
    }
    expect(citationSourceSchema.parse(source({ evidence: { tool: "read", callId: "call-1", turnId: null } }))).toMatchObject({ evidence: { callId: "call-1" } });
  });

  it("rejects an inverted line range and malformed identities", () => {
    expect(() => citationLocatorSchema.parse({ kind: "lines", startLine: 7, endLine: 2 })).toThrow();
    expect(() => citationSourceSchema.parse(source({ identity: "" }))).toThrow();
    expect(() => citationSourceSchema.parse(source({ kind: "pdf" }))).toThrow();
  });

  it("validates a citation sources response", () => {
    expect(citationSourcesResponseSchema.parse({ sessionId: "s1", sources: [source()] }).sources).toHaveLength(1);
    expect(() => citationSourcesResponseSchema.parse({ sessionId: "", sources: [] })).toThrow();
  });
});
