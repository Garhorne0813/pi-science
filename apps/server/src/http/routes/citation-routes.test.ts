import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerCitationRoutes } from "./citation-routes.js";
import { durableEventStore, type SseEventRecord } from "../../runtime/events/event-store.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-science-citation-route-"));
  roots.push(root);
  await mkdir(join(root, ".pi-science"), { recursive: true });
  await writeFile(join(root, "results.md"), "Line one\nLine two\n", "utf8");
  return root;
}

function toolRecord(data: Record<string, unknown>): SseEventRecord {
  return { event: null, id: null, data: JSON.stringify(data), created_at: new Date().toISOString() };
}

async function recordRead(cwd: string, sessionId: string, callId: string, turnId?: string, text = "Line one\nLine two"): Promise<void> {
  const turn = turnId ? { turnId } : {};
  await durableEventStore.append(cwd, sessionId, toolRecord({ type: "tool.started", sessionId, callId, itemId: callId, ...turn, tool: "read", status: "running", input: { path: "results.md" }, startedAt: "2026-11-02T02:00:00.000Z" }));
  // The projection stores the whole tool result as JSON, which is what the route reads back.
  await durableEventStore.append(cwd, sessionId, toolRecord({ type: "tool.completed", sessionId, callId, itemId: callId, ...turn, tool: "read", status: "done", output: JSON.stringify({ content: [{ type: "text", text }] }), endedAt: "2026-11-02T02:00:01.000Z" }));
}

function sourcesUrl(cwd: string, ...turnIds: string[]): string {
  const params = new URLSearchParams({ cwd, sessionId: "s1" });
  for (const turnId of turnIds) params.append("turnId", turnId);
  return `/api/citations/sources?${params}`;
}

function appFor(resolve: (cwd: string, sessionId: string) => Promise<string | null>) {
  const app = Fastify();
  apps.push(app);
  registerCitationRoutes(app, { findPath: resolve });
  return app;
}

describe("GET /api/citations/sources", () => {
  it("returns captured sources verified against the workspace file", async () => {
    const cwd = await workspace();
    await recordRead(cwd, "s1", "call-1", "turn-1");
    const app = appFor(async (workspaceCwd, sessionId) => workspaceCwd === cwd && sessionId === "s1" ? join(cwd, "session.jsonl") : null);
    const response = await app.inject({ method: "GET", url: sourcesUrl(cwd, "turn-1") });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: "s1",
      sources: [{
        id: "file:results.md",
        kind: "file",
        identity: "results.md",
        title: "results.md",
        locator: { kind: "lines", startLine: 1, endLine: 2 },
        excerpt: "Line one\nLine two",
        status: "verified",
        evidence: { tool: "read", callId: "call-1", turnId: "turn-1" },
      }],
    });
  });

  it("returns nothing for a request that names no turn", async () => {
    const cwd = await workspace();
    await recordRead(cwd, "s1", "call-1", "turn-1");
    const app = appFor(async (workspaceCwd, sessionId) => workspaceCwd === cwd && sessionId === "s1" ? join(cwd, "session.jsonl") : null);
    const response = await app.inject({ method: "GET", url: `/api/citations/sources?cwd=${encodeURIComponent(cwd)}&sessionId=s1` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: "s1", sources: [] });
  });

  it("binds a cited version to the turn that read it", async () => {
    const cwd = await workspace();
    await recordRead(cwd, "s1", "call-1", "turn-1", "Line one\nLine two");
    await writeFile(join(cwd, "results.md"), "Line one changed\n", "utf8");
    await recordRead(cwd, "s1", "call-2", "turn-2", "Line one changed");
    const app = appFor(async (workspaceCwd, sessionId) => workspaceCwd === cwd && sessionId === "s1" ? join(cwd, "session.jsonl") : null);
    const first = await app.inject({ method: "GET", url: sourcesUrl(cwd, "turn-1") });
    const second = await app.inject({ method: "GET", url: sourcesUrl(cwd, "turn-2") });
    const unrelated = await app.inject({ method: "GET", url: sourcesUrl(cwd, "turn-9") });
    expect(first.json()).toMatchObject({ sources: [{ excerpt: "Line one\nLine two", status: "changed" }] });
    expect(second.json()).toMatchObject({ sources: [{ excerpt: "Line one changed", status: "verified" }] });
    expect(unrelated.json()).toEqual({ sessionId: "s1", sources: [] });
  });

  it("returns an empty list for a session that belongs to another workspace", async () => {
    const cwd = await workspace();
    const other = await workspace();
    await recordRead(other, "s1", "call-1");
    const app = appFor(async (workspaceCwd, sessionId) => workspaceCwd === other && sessionId === "s1" ? join(other, "session.jsonl") : null);
    const response = await app.inject({ method: "GET", url: `/api/citations/sources?cwd=${encodeURIComponent(cwd)}&sessionId=s1` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: "s1", sources: [] });
  });

  it("returns an empty list without a session id", async () => {
    const cwd = await workspace();
    const app = appFor(async () => { throw new Error("must not be called"); });
    const response = await app.inject({ method: "GET", url: `/api/citations/sources?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: "", sources: [] });
  });

  it("rejects a cwd that is not a workspace", async () => {
    const app = appFor(async () => null);
    const response = await app.inject({ method: "GET", url: `/api/citations/sources?cwd=${encodeURIComponent(join(tmpdir(), "pi-science-missing-workspace"))}&sessionId=s1` });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: expect.any(String) });
  });

  it("reports an internal failure as 500", async () => {
    const cwd = await workspace();
    const app = appFor(async () => { throw new Error("session lookup failed"); });
    const response = await app.inject({ method: "GET", url: `/api/citations/sources?cwd=${encodeURIComponent(cwd)}&sessionId=s1` });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "session lookup failed" });
  });
});
