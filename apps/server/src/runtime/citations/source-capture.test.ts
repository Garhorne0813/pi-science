import { describe, expect, it } from "vitest";
import { captureCitationSources, isReadableText, normalizeWebUrl, normalizeWorkspacePath } from "./source-capture.js";
import type { SseEventRecord } from "../events/event-store.js";

const STARTED_AT = "2026-11-02T02:00:00.000Z";
const ENDED_AT = "2026-11-02T02:00:01.000Z";

function record(data: unknown): SseEventRecord {
  return { event: null, id: null, data: JSON.stringify(data), created_at: STARTED_AT };
}

/** The event projection stores a tool result as JSON, so that is what a test
 *  fixture has to look like. */
function result(text: string): string {
  return JSON.stringify({ content: [{ type: "text", text }] });
}

function started(callId: string, tool: string, input: Record<string, unknown>, turnId?: string): SseEventRecord {
  return record({ type: "tool.started", sessionId: "s1", callId, itemId: callId, ...(turnId ? { turnId } : {}), tool, status: "running", input, startedAt: STARTED_AT });
}

function completed(callId: string, tool: string, output: unknown, extra: Record<string, unknown> = {}): SseEventRecord {
  return record({ type: "tool.completed", sessionId: "s1", callId, itemId: callId, tool, status: "done", output, endedAt: ENDED_AT, ...extra });
}

describe("captureCitationSources", () => {
  it("captures a workspace file read and a fetched page with evidence", () => {
    const events = [
      started("c1", "read", { path: "./data/table.csv", offset: 2, limit: 3 }),
      completed("c1", "read", "a,b\n1,2\n3,4", { turnId: "turn-1" }),
      started("c2", "web_fetch", { url: "https://example.org/report?x=1#section", offset: 0, limit: 10 }),
      completed("c2", "web_fetch", "  Findings text  "),
      started("c3", "grep", { pattern: "doi:10.1000/x" }),
      completed("c3", "grep", "10.1000/x"),
    ];
    const sources = captureCitationSources(events);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      id: "file:data/table.csv",
      kind: "file",
      identity: "data/table.csv",
      title: "table.csv",
      locator: { kind: "lines", startLine: 2, endLine: 4 },
      excerpt: "a,b\n1,2\n3,4",
      capturedAt: ENDED_AT,
      evidence: { tool: "read", callId: "c1", turnId: "turn-1" },
    });
    expect(sources[1]).toMatchObject({
      id: "web:https://example.org/report?x=1",
      kind: "web",
      identity: "https://example.org/report?x=1",
      title: "example.org",
      locator: { kind: "chars", start: 0, end: 10 },
      excerpt: "Findings text",
      evidence: { tool: "web_fetch", callId: "c2", turnId: null },
    });
  });

  it("never turns binary tool output into a rendered excerpt", () => {
    const events = [
      started("c1", "read", { path: "draft.pdf" }),
      completed("c1", "read", "%PDF-1.7\u0000\u0000\u0001binary\uFFFD"),
      started("c2", "web_fetch", { url: "https://example.org/scan.pdf", offset: 0, limit: 100 }),
      completed("c2", "web_fetch", Buffer.from(Array.from({ length: 4096 }, (_value, index) => 128 + (index % 64))).toString("base64")),
    ];
    const sources = captureCitationSources(events);
    expect(sources[0]).toMatchObject({ excerpt: null, binary: true, locator: { kind: "whole-source" } });
    expect(sources[1]).toMatchObject({ excerpt: null, binary: true, locator: { kind: "whole-source" } });
    expect(isReadableText("Results\n\nWe found a 12% gain, see figure 3.")).toBe(true);
  });

  it("drops paths and urls outside the workspace or outside http(s)", () => {
    const events = [
      started("c1", "read", { path: "/etc/passwd" }), completed("c1", "read", "root"),
      started("c2", "read", { path: "..\\..\\secrets.txt" }), completed("c2", "read", "secret"),
      started("c3", "read", { path: "data/../secrets.txt" }), completed("c3", "read", "secret"),
      started("c4", "web_fetch", { url: "file:///etc/passwd" }), completed("c4", "web_fetch", "root"),
      started("c5", "web_fetch", { url: "javascript:alert(1)" }), completed("c5", "web_fetch", "alert"),
      started("c6", "web_fetch", { url: "ftp://example.org/x" }), completed("c6", "web_fetch", "x"),
    ];
    expect(captureCitationSources(events)).toEqual([]);
  });

  it("keeps the first capture of an identity and follows first-capture order", () => {
    const events = [
      started("c1", "read", { path: "b.md" }), completed("c1", "read", "second version"),
      started("c2", "read", { path: "a.md" }), completed("c2", "read", "alpha"),
      started("c3", "read", { path: "./b.md" }), completed("c3", "read", "third version"),
    ];
    const sources = captureCitationSources(events);
    expect(sources.map((source) => source.identity)).toEqual(["b.md", "a.md"]);
    expect(sources[0]?.excerpt).toBe("second version");
  });

  it("registers failed and interrupted reads as attempts without an excerpt", () => {
    const events = [
      started("c1", "read", { path: "a.md" }),
      started("c2", "read", { path: "b.md" }), completed("c2", "read", "boom", { status: "error" }),
      completed("c3", "read", "orphan"),
    ];
    // A completion with no start carries no read input, so nothing is registered for it.
    expect(captureCitationSources(events)).toMatchObject([
      { id: "file:a.md", excerpt: null, attempt: true },
      { id: "file:b.md", excerpt: null, attempt: true },
    ]);
  });

  it("lets a real read win over an earlier interrupted one for the same identity", () => {
    const events = [
      started("c1", "read", { path: "a.md" }),
      started("c2", "read", { path: "a.md" }), completed("c2", "read", "real content"),
    ];
    const sources = captureCitationSources(events);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ excerpt: "real content" });
    expect(sources[0]?.attempt).toBeUndefined();
  });

  it("unwraps the tool result the event projection persists", () => {
    const events = [
      started("c1", "read", { path: "data/table.csv" }),
      completed("c1", "read", result("a,b\n1,2")),
      started("c2", "web_fetch", { url: "https://example.org/report" }),
      completed("c2", "web_fetch", result("Findings")),
    ];
    expect(captureCitationSources(events).map((source) => source.excerpt)).toEqual(["a,b\n1,2", "Findings"]);
  });

  it("keeps the read tool's continuation note out of the excerpt and locator", () => {
    const text = "GATTACA\nGGGCCC\n\n[Showing lines 1-2 of 400. Use offset=3 to continue.]";
    const sources = captureCitationSources([started("c1", "read", { path: "seq.fasta" }), completed("c1", "read", result(text))]);
    expect(sources[0]).toMatchObject({ excerpt: "GATTACA\nGGGCCC", locator: { kind: "lines", startLine: 1, endLine: 2 } });
  });

  it("treats a result that carried an image part as binary", () => {
    const sources = captureCitationSources([
      started("c1", "read", { path: "figure.png" }),
      completed("c1", "read", JSON.stringify({ content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "AAAA", mimeType: "image/png" }] })),
    ]);
    expect(sources[0]).toMatchObject({ excerpt: null, binary: true });
  });

  it("binds each read to the turn that made it", () => {
    const events = [
      started("c1", "read", { path: "results.csv" }, "turn-1"), completed("c1", "read", "version A", { turnId: "turn-1" }),
      started("c2", "read", { path: "results.csv" }, "turn-2"), completed("c2", "read", "version B", { turnId: "turn-2" }),
    ];
    expect(captureCitationSources(events, { turnIds: ["turn-2"] }).map((source) => source.excerpt)).toEqual(["version B"]);
    expect(captureCitationSources(events, { turnIds: ["turn-3"] })).toEqual([]);
    expect(captureCitationSources(events)[0]?.excerpt).toBe("version A");
  });

  it("starts a line locator at the requested offset when no limit is given", () => {
    const sources = captureCitationSources([started("c1", "read", { path: "a.md", offset: 5 }), completed("c1", "read", "l5\nl6")]);
    expect(sources[0]?.locator).toEqual({ kind: "lines", startLine: 5, endLine: 6 });
  });

  it("keeps column-wrapped sequences readable and still rejects unbroken base64", () => {
    const line = "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKV";
    const fasta = `>sp|P69905|HBA_HUMAN\n${Array.from({ length: 60 }, () => line).join("\n")}\n`;
    expect(isReadableText(fasta)).toBe(true);
    expect(isReadableText("ACGT".repeat(400))).toBe(true);
    expect(isReadableText(Buffer.from(Array.from({ length: 4096 }, (_value, index) => 128 + (index % 64))).toString("base64"))).toBe(false);
  });

  it("skips malformed records and wrong field types without throwing", () => {
    const events: SseEventRecord[] = [
      { event: null, id: null, data: "{not json", created_at: STARTED_AT },
      record({ type: "tool.started", callId: 7, tool: "read", input: { path: "a.md" } }),
      started("c1", "read", { path: 42 }),
      completed("c1", "read", "text"),
      record({ type: "tool.started", callId: "c2", tool: "read", input: null }),
      completed("c2", "read", "text"),
      started("c3", "web_fetch", {}),
      completed("c3", "web_fetch", "text"),
      record(["not", "an", "object"]),
    ];
    expect(() => captureCitationSources(events)).not.toThrow();
    expect(captureCitationSources(events)).toEqual([]);
  });

  it("normalizes windows separators and rejects non-identifier values", () => {
    expect(normalizeWorkspacePath(".\\data\\table.csv")).toBe("data/table.csv");
    expect(normalizeWorkspacePath("data\\table.csv")).toBe("data/table.csv");
    expect(normalizeWorkspacePath("")).toBeNull();
    expect(normalizeWorkspacePath("./")).toBeNull();
    expect(normalizeWebUrl("HTTPS://Example.org/a#frag")).toBe("https://example.org/a");
    expect(normalizeWebUrl("not a url")).toBeNull();
  });
});
