import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLastEventId, registerSseRoutes, SseBackpressureBuffer } from "./sse-routes.js";

describe("SSE backpressure buffer", () => {
  it("stays bounded by item count and byte size", () => {
    const buffer = new SseBackpressureBuffer(8, 2);
    expect(buffer.enqueue("1234")).toBe(true);
    expect(buffer.enqueue("5678")).toBe(true);
    expect(buffer.enqueue("x")).toBe(false);
    expect(buffer.length).toBe(2);
  });

  it("consumes the accepted item when the stream signals backpressure", () => {
    const buffer = new SseBackpressureBuffer(100, 10);
    buffer.enqueue("first");
    buffer.enqueue("second");
    const firstDrain: string[] = [];
    buffer.drain((text) => { firstDrain.push(text); return false; });
    expect(firstDrain).toEqual(["first"]);
    expect(buffer.length).toBe(1);
    const secondDrain: string[] = [];
    buffer.drain((text) => { secondDrain.push(text); return true; });
    expect(secondDrain).toEqual(["second"]);
    expect(buffer.length).toBe(0);
  });
});

describe("SSE cursor selection", () => {
  it("accepts an explicit query cursor for a newly-created EventSource", () => {
    expect(resolveLastEventId(undefined, "epoch:42")).toBe("epoch:42");
  });

  it("prefers the standard Last-Event-ID header on browser reconnect", () => {
    expect(resolveLastEventId("epoch:43", "epoch:42")).toBe("epoch:43");
  });
});

describe("SSE session existence fallback", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-science-sse-"));
  mkdirSync(join(workspace, ".pi-science", "sessions"), { recursive: true });

  it("accepts a session that exists only in the live in-memory runtime", async () => {
    const app = Fastify();
    const sessionService = {
      exists: async () => false,
      liveSessions: () => [{ id: "fresh-session", cwd: workspace }],
    };
    let subscribed = false;
    const hub = {
      subscribe: async () => {
        subscribed = true;
        throw new Error("subscribe-reached");
      },
    };
    registerSseRoutes(app, sessionService as never, hub as never);
    const response = await app.inject({ method: "GET", url: `/api/sessions/fresh-session/events?cwd=${encodeURIComponent(workspace)}` });
    // The existence fallback let the request through to subscription — the
    // route did NOT reply with the terminal "session not found" error.
    expect(subscribed).toBe(true);
    expect(response.body).not.toContain("session not found in this workspace");
    await app.close();
  });

  it("still rejects a session that is neither on disk nor in memory", async () => {
    const app = Fastify();
    const sessionService = {
      exists: async () => false,
      liveSessions: () => [],
    };
    const hub = { subscribe: async () => ({ unsubscribe: () => undefined }) };
    registerSseRoutes(app, sessionService as never, hub as never);
    const response = await app.inject({ method: "GET", url: `/api/sessions/ghost/events?cwd=${encodeURIComponent(workspace)}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("session not found in this workspace");
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
