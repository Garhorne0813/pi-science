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
    buffer.drain((text) => {
      firstDrain.push(text);
      return false;
    });
    expect(firstDrain).toEqual(["first"]);
    expect(buffer.length).toBe(1);
    const secondDrain: string[] = [];
    buffer.drain((text) => {
      secondDrain.push(text);
      return true;
    });
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
    const response = await app
      .inject({
        method: "GET",
        url: `/api/sessions/fresh-session/events?cwd=${encodeURIComponent(workspace)}`,
      })
      .catch(() => undefined);
    // The existence fallback let the request through to subscription — the
    // route did NOT reply with the terminal "session not found" error.
    expect(subscribed).toBe(true);
    expect(response?.body ?? "").not.toContain("session not found in this workspace");
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
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/ghost/events?cwd=${encodeURIComponent(workspace)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("session not found in this workspace");
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe("bounded SSE transport", () => {
  it("bounds stream and application buffers together for a stalled reader", async () => {
    const { BoundedSseStream } = await import("../sse-stream.js");
    const stream = new BoundedSseStream(512 * 1024);
    const chunk = "x".repeat(16 * 1024);
    for (let i = 0; i < 512; i++) {
      stream.enqueue(chunk);
      expect(stream.bufferedBytes).toBeLessThanOrEqual(512 * 1024);
    }
    expect(stream.destroyed).toBe(true);
    expect(stream.readableLength).toBeLessThanOrEqual(64 * 1024);
    expect(stream.pendingItems).toBe(0);
  });

  it("resumes in order only when the consumer reads again", async () => {
    const { BoundedSseStream } = await import("../sse-stream.js");
    const stream = new BoundedSseStream();
    const chunks = Array.from({ length: 20 }, (_, i) => `${i}:` + "x".repeat(8192));
    for (const chunk of chunks) expect(stream.enqueue(chunk)).toBe(true);
    expect(stream.pendingItems).toBeGreaterThan(0);
    const received: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => received.push(chunk));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Buffer.concat(received).toString()).toBe(chunks.join(""));
    expect(stream.bufferedBytes).toBe(0);
    stream.destroy();
  });
});

it("starts consuming before replaying history larger than the transport budget", async () => {
  const { Readable } = await import("node:stream");
  const { ConversationEventHub } = await import("../../runtime/events/conversation-event-hub.js");
  const cwd = mkdtempSync(join(tmpdir(), "pi-science-large-replay-"));
  mkdirSync(join(cwd, ".pi-science"));
  const app = Fastify();
  let stream: import("node:stream").Readable | undefined;
  app.addHook("onSend", async (_request, _reply, payload) => {
    if (payload instanceof Readable) stream = payload;
    return payload;
  });
  const records = Array.from({ length: 256 }, (_, index) => ({
    id: `epoch:${index}`,
    event: "message",
    data: "x".repeat(8192),
    created_at: new Date().toISOString(),
  }));
  const hub = new ConversationEventHub({
    append: async () => undefined,
    readAfter: async () => records,
  });
  const subscribe = hub.subscribe.bind(hub);
  hub.subscribe = async (...args) => {
    const unsubscribe = await subscribe(...args);
    stream?.push(null);
    return unsubscribe;
  };
  registerSseRoutes(app, { exists: async () => true, liveSessions: () => [] } as never, hub);
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/replay/events?cwd=${encodeURIComponent(cwd)}&lastEventId=epoch:before`,
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.byteLength(response.body)).toBeGreaterThan(2 * 1024 * 1024);
    expect(response.body).toContain("id: epoch:255\n");
    expect(hub.hasSubscribers(cwd, "replay")).toBe(false);
  } finally {
    await app.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
