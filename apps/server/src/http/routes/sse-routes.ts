import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { ConversationEventHub } from "../../runtime/events/conversation-event-hub.js";
import type { SseEventRecord } from "../../runtime/events/event-store.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

const MAX_SSE_PENDING_BYTES = 512 * 1024;
const MAX_SSE_PENDING_ITEMS = 512;

export class SseBackpressureBuffer {
  private readonly pending: string[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly maxBytes = MAX_SSE_PENDING_BYTES,
    private readonly maxItems = MAX_SSE_PENDING_ITEMS,
  ) {}

  enqueue(text: string): boolean {
    const bytes = Buffer.byteLength(text);
    if (bytes > this.maxBytes || this.pending.length >= this.maxItems || this.pendingBytes + bytes > this.maxBytes) return false;
    this.pending.push(text);
    this.pendingBytes += bytes;
    return true;
  }

  drain(write: (text: string) => boolean): void {
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.pendingBytes -= Buffer.byteLength(next);
      if (!write(next)) return;
    }
  }

  get length(): number { return this.pending.length; }
  clear(): void { this.pending.length = 0; this.pendingBytes = 0; }
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
    let closed = false;
    let replaying = true;
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    // Keep `blocked` set once the stream refuses a push. Resetting it just
    // because the queue happened to drain re-enters the Readable's own buffer
    // with the next record, which defeats these caps: a whole replay backlog
    // then accumulates in memory instead of being bounded. Only the consumer
    // asking for more data (`read()`) clears the flag.
    const flush = () => {
      pending.drain((text) => {
        if (!stream.push(text)) { blocked = true; return false; }
        return true;
      });
    };
    const stream = new Readable({ highWaterMark: 64 * 1024, read() { blocked = false; flush(); } });
    // An overflowing stream must end with a signal the browser can act on.
    // Write this gap straight into the response, never through the hub:
    // publishing would stamp it with `<epoch>:<seq>`, and a sequenced gap opens
    // exactly the sequence hole the client uses this signal to heal.
    const closeWithGap = (reason: "replay_overflow" | "subscriber_overflow") => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      pending.clear();
      stream.push(serializeSseEvent({
        event: "stream.gap",
        id: null,
        data: JSON.stringify({
          type: "stream.gap",
          sessionId,
          reason,
          message: "The replay backlog exceeded the SSE buffer; rebase from the conversation snapshot before resuming live events.",
        }),
        created_at: new Date().toISOString(),
      }));
      stream.push(null);
    };
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
        // The consumer stopped draining (slow socket, or a replay that outran
        // the buffer). A truncated-but-open stream looks healthy forever, so
        // end it with a rebase hint instead of silently dropping events.
        closeWithGap(replaying ? "replay_overflow" : "subscriber_overflow");
        return false;
      }
      if (!blocked) flush();
      return !closed;
    };
    heartbeat = setInterval(() => {
      if (pending.length < 100) enqueue(": ping\n\n");
    }, 15_000);
    request.raw.once("close", cleanup);
    // Attach the response BEFORE the replay starts. Awaiting subscribe() first
    // leaves the Readable with no consumer while every replayed record is
    // pushed: the backlog piles up in memory and the client only learns about
    // events after the whole replay has already been buffered. Sending first
    // makes the response the consumer, so replayed records are written to the
    // socket and the caps above bound what a backlog may cost.
    reply.header("cache-control", "no-cache");
    reply.header("x-accel-buffering", "no");
    reply.header("x-pi-science-sse", "node-native");
    reply.type("text/event-stream").send(stream);
    // Emit an initial comment so Fastify flushes the SSE headers immediately.
    // Otherwise an idle session can leave clients waiting until the 15s
    // heartbeat before EventSource reports the connection as open.
    stream.push(": connected\n\n");
    try {
      unsubscribe = await conversationEventHub.subscribe(
        cwd,
        sessionId,
        lastEventId,
        (record) => enqueue(serializeSseEvent(record)),
        Boolean(lastEventId),
        // Delivery can give up on this subscriber (its own replay backlog cap,
        // or a failed write). The only way the browser learns is if this route
        // ends the response, so report it instead of leaving a connection that
        // keeps heartbeating while every event is dropped.
        (reason) => closeWithGap(reason === "replay_backlog_overflow" ? "replay_overflow" : "subscriber_overflow"),
      );
    } catch (error) {
      // The reply is already committed to Fastify as a stream payload, so a
      // rethrow goes through the error handler instead of ending the request
      // cleanly: reply.sent only short-circuits once the response has ended, so
      // the handler tries to write a 500 — if the headers have not flushed the
      // client gets a JSON 500, otherwise writeHead throws ERR_HTTP_HEADERS_SENT
      // and the connection is torn down. Either way the failure arrives as a
      // transport fault, not a terminal event. Answer with the same terminal
      // error frame as the not-found branch.
      request.log.error({ err: error }, "SSE subscription failed");
      if (!closed) {
        stream.push(serializeSseEvent({
          event: "error",
          id: null,
          data: JSON.stringify({
            type: "error",
            sessionId,
            message: error instanceof Error ? error.message : String(error),
            code: "subscribe_failed",
            terminal: true,
          }),
          created_at: new Date().toISOString(),
        }));
      }
      cleanup();
    } finally {
      replaying = false;
    }
    if (closed) unsubscribe?.();
    return reply;
  });
}

function serializeSseEvent(event: SseEventRecord): string {
  const lines: string[] = [];
  if (event.id) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  for (const line of event.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}
