import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { durableEventStore, type SseEventRecord } from "./event-store.js";
import type { PiEvent, PiProcess } from "./pi-process.js";

type Subscriber = {
  ready: boolean;
  pending: SseEventRecord[];
  delivered: Set<string>;
  cancelled: boolean;
  deliver: (record: SseEventRecord) => unknown;
};

type EventStore = {
  append(cwd: string, sessionId: string, event: SseEventRecord): Promise<void>;
  readAfter(cwd: string, sessionId: string, lastEventId?: string | null): Promise<SseEventRecord[]>;
};

type BindingOptions = {
  activeSessionId: () => string | null;
  onBusy: (busy: boolean) => void;
  onExit: () => void;
  observe?: (event: PiEvent, sessionId: string) => Promise<void> | void;
};

type TurnState = {
  hadText: boolean;
  hadError: boolean;
  hadActivity: boolean;
  textByKey: Map<string, string>;
  anonymousSerial: number;
  activeAnonymousKey: string | null;
};

type StderrChunk = { text: string; at: number; turn: number };

const MAX_EVENT_TEXT = 20_000;
const MAX_SUBSCRIBER_REPLAY_PENDING = 2_000;
const STDERR_WINDOW_MS = 30_000;

function streamKey(cwd: string, sessionId: string): string {
  return `${resolve(cwd)}\0${sessionId}`;
}

function cap(value: unknown, limit = MAX_EVENT_TEXT): string {
  const text = typeof value === "string" ? value : stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? ""); } catch { return String(value ?? ""); }
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth limit]";
  if (typeof value === "string") return cap(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([key, item]) => [key, safeValue(item, depth + 1)]));
  }
  return value;
}

function assistantText(event: PiEvent): { type: string; text: string; messageId: string; contentIndex: string } | null {
  if (event.type !== "message_update") return null;
  const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistant) return null;
  const type = String(assistant.type ?? "");
  if (!["text_delta", "text", "text_end"].includes(type)) return null;
  const message = event.message as Record<string, unknown> | undefined;
  const text = String(assistant.text ?? assistant.delta ?? assistant.content ?? "");
  return {
    type,
    text,
    messageId: typeof message?.id === "string" ? message.id : "",
    contentIndex: String(assistant.contentIndex ?? "0"),
  };
}

function recordKey(record: SseEventRecord): string {
  return record.id ?? `${record.created_at}\0${record.event ?? ""}\0${record.data}`;
}

function modelError(event: PiEvent): string | null {
  if (event.type !== "message_end") return null;
  const message = (event.message && typeof event.message === "object" ? event.message : event) as Record<string, unknown>;
  const stopReason = String(message.stopReason ?? event.stopReason ?? "");
  const errorMessage = message.errorMessage ?? event.errorMessage;
  return stopReason === "error" || errorMessage ? String(errorMessage ?? "The model request failed") : null;
}

export class ConversationEventHub {
  private readonly epoch = randomUUID();
  private readonly sequences = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly publishing = new Map<string, Promise<void>>();
  private readonly turns = new Map<string, TurnState>();
  private readonly bound = new WeakSet<PiProcess>();
  private readonly expectedExits = new WeakSet<PiProcess>();

  constructor(private readonly eventStore: EventStore = durableEventStore) {}

  expectExit(process: PiProcess): void {
    this.expectedExits.add(process);
  }

  bind(cwd: string, process: PiProcess, options: BindingOptions): void {
    if (this.bound.has(process)) return;
    this.bound.add(process);
    const boundAt = Date.now();
    let turnNumber = 0;
    let turnStartedAt = boundAt;
    let eventQueue = Promise.resolve();
    const stderr: StderrChunk[] = [];
    process.on("stderr", (chunk: string) => {
      stderr.push({ text: cap(chunk, 4_000), at: Date.now(), turn: turnNumber });
      while (stderr.reduce((size, item) => size + item.text.length, 0) > 16_000) stderr.shift();
    });
    process.on("malformed", (line: string) => {
      const sessionId = options.activeSessionId();
      if (sessionId) void this.publish(cwd, sessionId, { type: "error", sessionId, message: `Malformed Pi RPC output: ${cap(line, 500)}`, recoverable: true });
    });
    process.on("event", (event: PiEvent) => {
      const sessionId = this.eventSessionId(event) ?? options.activeSessionId();
      if (!sessionId) return;
      if (event.type === "agent_start") {
        turnNumber += 1;
        turnStartedAt = Date.now();
        stderr.length = 0;
        options.onBusy(true);
      }
      if (event.type === "agent_settled") options.onBusy(false);
      eventQueue = eventQueue.catch(() => undefined).then(async () => {
        for (const normalized of this.normalize(cwd, sessionId, event)) {
          await this.publish(cwd, sessionId, normalized);
        }
        await Promise.resolve(options.observe?.(event, sessionId)).catch(() => undefined);
      });
    });
    process.on("exit", ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
      const sessionId = options.activeSessionId();
      options.onBusy(false);
      options.onExit();
      if (this.expectedExits.has(process)) return;
      if (!sessionId) return;
      const now = Date.now();
      const recentStderr = stderr
        .filter((item) => item.turn === turnNumber && item.at >= turnStartedAt && now - item.at <= STDERR_WINDOW_MS)
        .map((item) => item.text)
        .join("");
      const suffix = recentStderr ? `\n${cap(recentStderr, 8_000)}` : "";
      void eventQueue.catch(() => undefined).then(async () => {
        await this.publish(cwd, sessionId, {
          type: "error",
          sessionId,
          message: `Pi process exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.${suffix}`,
          terminal: true,
        });
        await this.publish(cwd, sessionId, { type: "session.idle", sessionId });
      });
    });
  }

  async subscribe(
    cwd: string,
    sessionId: string,
    lastEventId: string | undefined,
    deliver: (record: SseEventRecord) => unknown,
  ): Promise<() => void> {
    const key = streamKey(cwd, sessionId);
    const subscriber: Subscriber = { ready: false, pending: [], delivered: new Set(), cancelled: false, deliver };
    const set = this.subscribers.get(key) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(key, set);
    const unsubscribe = () => {
      if (subscriber.cancelled) return;
      subscriber.cancelled = true;
      subscriber.pending.length = 0;
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(key);
    };
    const send = (record: SseEventRecord): boolean => {
      if (subscriber.cancelled) return false;
      const identity = recordKey(record);
      if (subscriber.delivered.has(identity)) return true;
      subscriber.delivered.add(identity);
      if (deliver(record) === false) {
        unsubscribe();
        return false;
      }
      return true;
    };
    const replay = await this.eventStore.readAfter(cwd, sessionId, lastEventId);
    for (const record of replay) {
      if (!send(record)) return unsubscribe;
    }
    subscriber.ready = true;
    for (const record of subscriber.pending) {
      if (!send(record)) return unsubscribe;
    }
    subscriber.pending.length = 0;
    subscriber.delivered.clear();
    return unsubscribe;
  }

  publish(cwd: string, sessionId: string, payload: Record<string, unknown>): Promise<void> {
    const key = streamKey(cwd, sessionId);
    const previous = this.publishing.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const sequence = (this.sequences.get(key) ?? 0) + 1;
      this.sequences.set(key, sequence);
      const record: SseEventRecord = {
        event: String(payload.type ?? "runtime.event"),
        id: `${this.epoch}:${sequence}`,
        data: JSON.stringify(safeValue(payload)),
        created_at: new Date().toISOString(),
      };
      try { await this.eventStore.append(cwd, sessionId, record); } catch { /* live delivery must survive a persistence outage */ }
      for (const subscriber of this.subscribers.get(key) ?? []) {
        if (subscriber.cancelled) continue;
        if (subscriber.ready) {
          if (subscriber.deliver(record) === false) {
            subscriber.cancelled = true;
            this.subscribers.get(key)?.delete(subscriber);
          }
        } else if (subscriber.pending.length >= MAX_SUBSCRIBER_REPLAY_PENDING) {
          subscriber.cancelled = true;
          subscriber.pending.length = 0;
          this.subscribers.get(key)?.delete(subscriber);
        } else {
          subscriber.pending.push(record);
        }
      }
    });
    this.publishing.set(key, next);
    void next.then(() => {
      if (this.publishing.get(key) === next) this.publishing.delete(key);
    }, () => { if (this.publishing.get(key) === next) this.publishing.delete(key); });
    return next;
  }

  private eventSessionId(event: PiEvent): string | null {
    for (const value of [event._piSessionId, event.sessionId, event.session_id]) {
      if (typeof value === "string" && value) return value;
    }
    return null;
  }

  private normalize(cwd: string, sessionId: string, event: PiEvent): Record<string, unknown>[] {
    const key = streamKey(cwd, sessionId);
    let turn = this.turns.get(key);
    if (!turn) {
      turn = { hadText: false, hadError: false, hadActivity: false, textByKey: new Map(), anonymousSerial: 0, activeAnonymousKey: null };
      this.turns.set(key, turn);
    }
    if (event.type === "agent_start") {
      turn.hadText = false;
      turn.hadError = false;
      turn.hadActivity = false;
      turn.textByKey.clear();
      turn.activeAnonymousKey = null;
      return [{ type: "agent_start", sessionId }];
    }

    const text = assistantText(event);
    if (text) {
      if (!text.messageId && !turn.activeAnonymousKey) {
        turn.activeAnonymousKey = `anonymous-${++turn.anonymousSerial}`;
      }
      const messageKey = text.messageId || turn.activeAnonymousKey!;
      const key = `${messageKey}:${text.contentIndex}`;
      const accumulated = turn.textByKey.get(key) ?? "";
      let emitted = text.text;
      let replace = false;
      if (text.type === "text_end") {
        if (text.text === accumulated) emitted = "";
        else if (text.text.startsWith(accumulated)) emitted = text.text.slice(accumulated.length);
        else if (accumulated) replace = true;
        turn.textByKey.set(key, text.text);
        if (!text.messageId) turn.activeAnonymousKey = null;
      } else {
        turn.textByKey.set(key, accumulated + text.text);
      }
      if (text.text.trim() || accumulated.trim()) turn.hadText = true;
      if (!emitted && !replace) return [];
      return [{ type: "text.updated", sessionId, partId: messageKey, text: cap(emitted), ...(replace ? { replace: true } : {}) }];
    }

    const exactError = modelError(event);
    if (exactError) {
      turn.hadError = true;
      return [{ type: "error", sessionId, message: cap(exactError) }];
    }

    switch (event.type) {
      case "message_start": {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role !== "assistant") return [];
        const partId = typeof message.id === "string" && message.id
          ? message.id
          : `anonymous-${++turn.anonymousSerial}`;
        turn.activeAnonymousKey = typeof message.id === "string" && message.id ? null : partId;
        return [{ type: "text.updated", sessionId, partId, text: "" }];
      }
      case "tool_execution_start":
        turn.hadActivity = true;
        return [{ type: "tool.updated", sessionId, callId: String(event.toolCallId ?? ""), tool: String(event.toolName ?? "unknown"), status: "running", input: safeValue(event.args ?? {}), startedAt: new Date().toISOString() }];
      case "tool_execution_update":
        turn.hadActivity = true;
        return [{ type: "tool.updated", sessionId, callId: String(event.toolCallId ?? ""), tool: String(event.toolName ?? ""), status: "running", partialOutput: cap(event.partialResult) }];
      case "tool_execution_end":
        turn.hadActivity = true;
        return [{ type: "tool.updated", sessionId, callId: String(event.toolCallId ?? ""), tool: String(event.toolName ?? ""), status: event.isError ? "error" : "done", output: cap(event.result), endedAt: new Date().toISOString() }];
      case "extension_ui_request": {
        turn.hadActivity = true;
        const method = String(event.method ?? "");
        if (method === "confirm") return [{ type: "permission.asked", sessionId, requestId: String(event.id ?? ""), title: String(event.title ?? "Confirmation"), message: cap(event.message) }];
        if (["select", "input", "editor"].includes(method)) return [{ type: "question.asked", sessionId, requestId: String(event.id ?? ""), method, title: String(event.title ?? "Question"), message: cap(event.message), options: safeValue(event.options ?? []), placeholder: String(event.placeholder ?? ""), prefill: String(event.prefill ?? "") }];
        return [];
      }
      case "artifact_published":
        turn.hadActivity = true;
        return [{ type: "artifact.published", sessionId, artifactId: String(event.artifactId ?? ""), path: String(event.path ?? ""), version: event.version, mime: String(event.mime ?? ""), verification: safeValue(event.verification ?? {}) }];
      case "compaction_start":
      case "compaction_update":
      case "compaction_end":
      case "compaction_error":
        return [{ type: "compaction.updated", sessionId, status: event.type.replace("compaction_", ""), message: cap(event.message ?? event.error ?? ""), progress: event.progress }];
      case "extension_error":
        turn.hadError = true;
        return [{ type: "error", sessionId, message: cap(event.message ?? event.error ?? "Extension failed") }];
      case "error":
        turn.hadError = true;
        return [{ type: "error", sessionId, message: cap(event.message ?? event.error ?? "Pi runtime error") }];
      case "retry_start":
      case "retry_update":
      case "retry_end":
      case "status":
        return [{ type: "status.updated", sessionId, status: event.type, message: cap(event.message ?? ""), attempt: event.attempt }];
      case "agent_end":
        return [{ type: "agent_end", sessionId }];
      case "agent_settled": {
        const records: Record<string, unknown>[] = [];
        if (!turn.hadText && !turn.hadError && !turn.hadActivity && !event.handledWithoutTurn) {
          records.push({
            type: "error",
            sessionId,
            message: "The model returned an empty response. Check the configured API key, model ID, thinking level, and network connection.",
          });
        }
        records.push({ type: "session.idle", sessionId, ...(event.handledWithoutTurn ? { handledWithoutTurn: true } : {}) });
        turn.hadText = false;
        turn.hadError = false;
        turn.hadActivity = false;
        turn.textByKey.clear();
        turn.activeAnonymousKey = null;
        return records;
      }
      default:
        return [];
    }
  }
}

export const conversationEventHub = new ConversationEventHub();
