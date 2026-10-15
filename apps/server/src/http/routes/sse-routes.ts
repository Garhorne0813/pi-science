import { Readable } from "node:stream";
import { BoundedQueue } from "../backpressure-queue.js";
import type { FastifyInstance } from "fastify";
import type { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";
import type { SseEventRecord } from "../../runtime/events/event-store.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

const MAX_SSE_PENDING_BYTES = 512 * 1024;
const MAX_SSE_PENDING_ITEMS = 512;

export class SseBackpressureBuffer {
  private readonly pending: BoundedQueue;

  constructor(maxBytes = MAX_SSE_PENDING_BYTES, maxItems = MAX_SSE_PENDING_ITEMS) {
    this.pending = new BoundedQueue({ maxBytes, maxItems });
  }

  enqueue(text: string): boolean { return this.pending.offer(text); }

  drain(write: (text: string) => boolean): void {
    let next: string | undefined;
    while ((next = this.pending.shift()) !== undefined) if (!write(next)) return;
  }

  get length(): number { return this.pending.items; }
  clear(): void { this.pending.clear(); }
}

export function resolveLastEventId(headerValue: unknown, queryValue: unknown): string | undefined {
  const headerCursor = typeof headerValue === "string" && headerValue.length > 0 ? headerValue : undefined;
  const queryCursor = typeof queryValue === "string" && queryValue.length > 0 ? queryValue : undefined;
  return headerCursor || queryCursor;
}

export function registerSseRoutes(app: FastifyInstance, nodeSessionService: NodeSessionService, conversationEventHub: ConversationEventHub): void {
  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/events/cursor", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    const requestedCwd = typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(requestedCwd);
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }
    const sessionId = request.params.session_id;
    const sessionExists = await nodeSessionService.exists(sessionId, cwd)
      || nodeSessionService.liveSessions(cwd).some((session) => session.id === sessionId);
    if (!sessionExists) return reply.code(404).send({ error: "session not found in this workspace" });
    return { resumeCursor: await conversationEventHub.latestCursor(cwd, sessionId) };
  });

  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/events", async (request, reply) => {
    const query = request.query as { cwd?: unknown; lastEventId?: unknown };
    const requestedCwd = typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(requestedCwd);
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }

    const sessionId = request.params.session_id;
    // A freshly-created session may not have flushed its JSONL yet: the Pi
    // process writes the session file only after emitting the session event,
    // so an SSE connect that arrives right after POST /api/sessions returns
    // would see exists()==false and tear the conversation down. Treat a
    // still-running in-memory runtime as proof of existence so the stream
    // attaches and replays events as they land.
    const sessionExists = await nodeSessionService.exists(sessionId, cwd)
      || nodeSessionService.liveSessions(cwd).some((session) => session.id === sessionId);
    if (!sessionExists) {
      return reply
        .type("text/event-stream")
        .send(serializeSseEvent({
          event: "error",
          id: null,
          data: JSON.stringify({
            type: "error",
            sessionId,
            message: "session not found in this workspace",
            code: "not_found",
            terminal: true,
          }),
          created_at: new Date().toISOString(),
        }));
    }

    const lastEventId = resolveLastEventId(request.headers["last-event-id"]?.toString(), query.lastEventId);
    const pending = new SseBackpressureBuffer();
    let blocked = false;
    const flush = () => {
      pending.drain((text) => {
        if (!stream.push(text)) { blocked = true; return false; }
        return true;
      });
      if (pending.length === 0) blocked = false;
    };
    const stream = new Readable({ highWaterMark: 64 * 1024, read() { blocked = false; flush(); } });
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      pending.clear();
      stream.push(null);
    };
    const enqueue = (text: string) => {
      if (closed) return false;
      if (!pending.enqueue(text)) {
        cleanup();
        return false;
      }
      if (!blocked) flush();
      return !closed;
    };
    heartbeat = setInterval(() => {
      if (pending.length < 100) enqueue(": ping\n\n");
    }, 15_000);
    request.raw.once("close", cleanup);
    unsubscribe = await conversationEventHub.subscribe(
      cwd,
      sessionId,
      lastEventId,
      (record) => enqueue(serializeSseEvent(record)),
      Boolean(lastEventId),
    );
    if (closed) unsubscribe();
    // Emit an initial comment so Fastify flushes the SSE headers immediately.
    // Otherwise an idle session can leave clients waiting until the 15s
    // heartbeat before EventSource reports the connection as open.
    enqueue(": connected\n\n");
    reply.header("cache-control", "no-cache");
    reply.header("x-accel-buffering", "no");
    reply.header("x-pi-science-sse", "node-native");
    return reply.type("text/event-stream").send(stream);
  });
}

function serializeSseEvent(event: SseEventRecord): string {
  const lines: string[] = [];
  if (event.id) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  for (const line of event.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}
