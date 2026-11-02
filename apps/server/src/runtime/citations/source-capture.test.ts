import { describe, expect, it } from "vitest";
import { captureCitationSources, isReadableText, normalizeWebUrl, normalizeWorkspacePath } from "./source-capture.js";
import type { SseEventRecord } from "../events/event-store.js";

const STARTED_AT = "2026-11-02T02:00:00.000Z";
const ENDED_AT = "2026-11-02T02:00:01.000Z";

function record(data: unknown): SseEventRecord {
  return { event: null, id: null, data: JSON.stringify(data), created_at: STARTED_AT };
}

function started(callId: string, tool: string, input: Record<string, unknown>, turnId?: string): SseEventRecord {
  return record({ type: "tool.started", sessionId: "s1", callId, itemId: callId, ...(turnId ? { turnId } : {}), tool, status: "running", input, startedAt: STARTED_AT });
}

function completed(callId: string, tool: string, output: string, extra: Record<string, unknown> = {}): SseEventRecord {
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

  it("ignores calls without a matching completion and failed calls", () => {
    const events = [
      started("c1", "read", { path: "a.md" }),
      started("c2", "read", { path: "b.md" }), completed("c2", "read", "boom", { status: "error" }),
      completed("c3", "read", "orphan"),
    ];
    expect(captureCitationSources(events)).toEqual([]);
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
