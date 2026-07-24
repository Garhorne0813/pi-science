import { Readable, Transform } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { conversationEventHub } from "./conversation-event-hub.js";
import { durableEventStore, parseSseBlock, type SseEventRecord } from "./event-store.js";
import { nodeSessionService } from "./node-session-service.js";
import { validateWorkspaceCwd } from "./workspace-security.js";

const MAX_SSE_PENDING_BYTES = 512 * 1024;
const MAX_SSE_PENDING_ITEMS = 512;
const COMPATIBILITY_DEDUPE_LIMIT = 10_000;
const compatibilityRecorded = new Map<string, Set<string>>();

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

export function registerSseRoutes(app: FastifyInstance, config: ServerConfig): void {
  app.get<{ Params: { session_id: string } }>("/api/sessions/:session_id/events", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    const requestedCwd = typeof query.cwd === "string" && query.cwd.length > 0 ? query.cwd : ".";
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(requestedCwd);
    } catch (error) {
      return reply.code(403).send({ error: String(error) });
    }

    // In compatibility mode Python owns both the Pi process and its event
    // stream. Keep the old bridge for that mode; native Node mode must never
    // send prompts to Node and then look for events in Python.
    if (!config.nodePiManager) {
      return bridgeScientificSse(request, reply, config.pythonOrigin, cwd);
    }

    const sessionId = request.params.session_id;
    const resumed = await nodeSessionService.resume(sessionId, cwd);
    if (!resumed.success) {
      return reply
        .type("text/event-stream")
        .send(serializeSseEvent({
          event: "error",
          id: null,
          data: JSON.stringify({
            type: "error",
            sessionId,
            message: resumed.error ?? "session not found in this workspace",
            code: resumed.code,
            terminal: true,
          }),
          created_at: new Date().toISOString(),
        }));
    }

    const lastEventId = request.headers["last-event-id"]?.toString();
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

async function bridgeScientificSse(
  request: any,
  reply: any,
  pythonOrigin: string,
  cwd: string,
) {
  const sessionId = request.params.session_id as string;
  const lastEventId = request.headers["last-event-id"]?.toString();
  const target = new URL(`${pythonOrigin}/api/sessions/${encodeURIComponent(sessionId)}/events`);
  target.searchParams.set("cwd", cwd);
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: lastEventId ? { "last-event-id": lastEventId } : undefined,
      signal: controller.signal,
    });
  } catch {
    if (lastEventId) {
      const replay = await durableEventStore.readAfter(cwd, sessionId, lastEventId);
      if (replay.length > 0) {
        reply.header("cache-control", "no-cache");
        reply.header("x-pi-science-sse", "node-replay");
        return reply.type("text/event-stream").send(replay.map(serializeSseEvent).join(""));
      }
    }
    return reply.code(503).send({ error: "scientific runtime unavailable" });
  }
  if (!upstream.ok || !upstream.body) {
    return reply.code(upstream.status || 502).send({ error: "session event stream unavailable" });
  }
  let pending = "";
  const recorder = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = pending + chunk.toString("utf8");
      const blocks = text.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (parsed) recordCompatibilityEvent(cwd, sessionId, parsed);
      }
      callback(null, chunk);
    },
    flush(callback) {
      const parsed = parseSseBlock(pending);
      if (parsed) recordCompatibilityEvent(cwd, sessionId, parsed);
      callback();
    },
  });
  const stream = Readable.fromWeb(upstream.body as any).pipe(recorder);
  reply.header("cache-control", "no-cache");
  reply.header("x-accel-buffering", "no");
  reply.header("x-pi-science-sse", "node");
  return reply.type("text/event-stream").send(stream);
}

function recordCompatibilityEvent(cwd: string, sessionId: string, event: SseEventRecord): void {
  const stream = `${cwd}\0${sessionId}`;
  const identity = event.id ?? `${event.event ?? ""}\0${event.data}`;
  const recorded = compatibilityRecorded.get(stream) ?? new Set<string>();
  if (recorded.has(identity)) return;
  recorded.add(identity);
  if (recorded.size > COMPATIBILITY_DEDUPE_LIMIT) recorded.delete(recorded.values().next().value!);
  compatibilityRecorded.set(stream, recorded);
  void durableEventStore.append(cwd, sessionId, event).catch(() => {
    recorded.delete(identity);
  });
}


function serializeSseEvent(event: SseEventRecord): string {
  const lines: string[] = [];
  if (event.id) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  for (const line of event.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}
