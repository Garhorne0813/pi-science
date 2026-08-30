import { resolve } from "node:path";
import { durableEventStore, type EventPublishGuard, type SseEventRecord } from "./event-store.js";
import type { PiEvent, PiProcess } from "../pi/pi-process.js";
import { toolActivityPresentation, toolActivityTitle } from "../presentation/tool-activity-presenters.js";

type Subscriber = {
  ready: boolean;
  pending: SseEventRecord[];
  delivered: Set<string>;
  cancelled: boolean;
  deliver: (record: SseEventRecord) => unknown;
};

type EventStore = {
  append(cwd: string, sessionId: string, event: SseEventRecord): Promise<void>;
  appendConditional?: (cwd: string, sessionId: string, event: SseEventRecord, guard: EventPublishGuard) => Promise<boolean>;
  readAfter(cwd: string, sessionId: string, lastEventId?: string | null): Promise<SseEventRecord[]>;
  nextSequence?: (cwd: string, sessionId: string) => Promise<number>;
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
type PendingText = {
  cwd: string;
  sessionId: string;
  payload: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_EVENT_TEXT = 20_000;
const MAX_SUBSCRIBER_REPLAY_PENDING = 2_000;
const STDERR_WINDOW_MS = 30_000;
const TEXT_BATCH_MS = 50;
const BROWSER_QUESTIONNAIRE_REQUEST_PREFIX = "pi-science-questionnaire-v1:";

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

function questionnairePayload(sessionId: string, toolCallId: string, args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const rawQuestions = (args as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const questions = rawQuestions.slice(0, 4).flatMap((rawQuestion) => {
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return [];
    const question = rawQuestion as Record<string, unknown>;
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    return [{
      question: cap(question.question),
      header: cap(question.header, 200),
      multiSelect: question.multiSelect === true,
      options: rawOptions.slice(0, 4).flatMap((rawOption) => {
        if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
        const option = rawOption as Record<string, unknown>;
        return [{
          label: cap(option.label, 500),
          description: cap(option.description),
          ...(typeof option.preview === "string" && option.preview.length > 0 ? { preview: cap(option.preview) } : {}),
        }];
      }),
    }];
  });
  return { type: "questionnaire.asked", sessionId, toolCallId, questions };
}

function browserQuestionnaireRequestId(title: unknown): string | null {
  if (typeof title !== "string" || !title.startsWith(BROWSER_QUESTIONNAIRE_REQUEST_PREFIX)) return null;
  const encoded = title.slice(BROWSER_QUESTIONNAIRE_REQUEST_PREFIX.length);
  if (!encoded) return null;
  try {
    const value = decodeURIComponent(encoded);
    return value || null;
  } catch {
    return null;
  }
}

function textSnapshot(value: unknown, contentIndex: number): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const part = content[contentIndex];
  if (!part || typeof part !== "object" || Array.isArray(part)) return undefined;
  const record = part as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string" ? record.text : undefined;
}

function assistantText(event: PiEvent): { type: string; text: string; snapshot?: string; messageId: string; contentIndex: string; presentationRole?: "intermediate" | "final" } | null {
  if (event.type !== "message_update") return null;
  const assistant = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!assistant) return null;
  const type = String(assistant.type ?? "");
  if (!["text_delta", "text", "text_end"].includes(type)) return null;
  const message = event.message as Record<string, unknown> | undefined;
  const contentIndex = Number(assistant.contentIndex ?? 0);
  const text = String(
    type === "text_delta"
      ? assistant.delta ?? assistant.text ?? assistant.content ?? ""
      : assistant.content ?? assistant.text ?? assistant.delta ?? "",
  );
  // Pi includes the complete in-progress assistant message on every delta.
  // Prefer that authoritative snapshot over heuristics on provider chunks:
  // some providers resend or overlap deltas, while the snapshot remains
  // correct. `event.message` is a compatibility fallback for older runtimes.
  const snapshot = textSnapshot(assistant.partial, contentIndex)
    ?? textSnapshot(message, contentIndex);
  const role = assistant.presentationRole ?? message?.presentationRole;
  return {
    type,
    text,
    ...(snapshot === undefined ? {} : { snapshot }),
    messageId: typeof message?.id === "string" ? message.id : "",
    contentIndex: String(assistant.contentIndex ?? "0"),
    ...(role === "final" || role === "intermediate" ? { presentationRole: role } : {}),
  };
}

function recordKey(record: SseEventRecord): string {
  return record.id ?? `${record.created_at}\0${record.event ?? ""}\0${record.data}`;
}

function recordPayload(record: SseEventRecord): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(record.data) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sequenceFromCursor(id: string | null): number {
  if (!id) return 0;
  const separator = id.lastIndexOf(":");
  const value = separator >= 0 ? id.slice(separator + 1) : id;
  const sequence = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(sequence) ? sequence : 0;
}

function modelError(event: PiEvent): string | null {
  if (event.type !== "message_end") return null;
  const message = (event.message && typeof event.message === "object" ? event.message : event) as Record<string, unknown>;
  const stopReason = String(message.stopReason ?? event.stopReason ?? "");
  const errorMessage = message.errorMessage ?? event.errorMessage;
  return stopReason === "error" || errorMessage ? String(errorMessage ?? "The model request failed") : null;
}

export class ConversationEventHub {
  private readonly sequences = new Map<string, number>();
  private readonly sequenceInitializers = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly pendingInteractions = new Map<string, SseEventRecord[]>();
  private readonly publishing = new Map<string, Promise<void>>();
  private readonly pendingText = new Map<string, PendingText>();
  private readonly turns = new Map<string, TurnState>();
  private readonly bound = new WeakSet<PiProcess>();
  private readonly expectedExits = new WeakSet<PiProcess>();
  /** Per-process throttle for immediate stderr forwarding (ms). */
  private readonly stderrLogAt = new WeakMap<PiProcess, number>();
  private log: (level: "info" | "warn" | "error", message: string) => void = () => {};

  constructor(private readonly eventStore: EventStore = durableEventStore) {}

  /** Route runtime stderr diagnostics to the control-plane logger. */
  configureLogging(log: (level: "info" | "warn" | "error", message: string) => void): void {
    this.log = log;
  }

  async flush(): Promise<void> {
    // Process exit handlers append terminal records through their event queue.
    // Yield once so those publishes are registered before taking the snapshot.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all([...this.pendingText.values()].map((pending) => this.flushPendingText(pending.cwd, pending.sessionId)));
    await Promise.allSettled([...this.publishing.values()]);
  }

  expectExit(process: PiProcess): void {
    this.expectedExits.add(process);
  }

  hasSubscribers(cwd: string, sessionId: string): boolean {
    return (this.subscribers.get(streamKey(cwd, sessionId))?.size ?? 0) > 0;
  }

  resolvePendingInteraction(cwd: string, sessionId: string, requestId: string): void {
    if (!requestId) return;
    const key = streamKey(cwd, sessionId);
    const pending = this.pendingInteractions.get(key);
    if (!pending) return;

    const request = pending
      .map((record) => recordPayload(record))
      .find((payload) => (
        (payload?.type === "question.asked" || payload?.type === "permission.asked")
        && payload.requestId === requestId
      ));
    const toolCallId = request?.questionnaire === true && typeof request.toolCallId === "string"
      ? request.toolCallId
      : null;
    const remaining = pending.filter((record) => {
      const payload = recordPayload(record);
      if (!payload) return true;
      if (
        (payload.type === "question.asked" || payload.type === "permission.asked")
        && payload.requestId === requestId
      ) return false;
      if (toolCallId !== null && payload.type === "questionnaire.asked" && payload.toolCallId === toolCallId) return false;
      return true;
    });
    if (remaining.length > 0) this.pendingInteractions.set(key, remaining);
    else this.pendingInteractions.delete(key);
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
      // Forward diagnostics immediately (throttled) instead of hiding them in
      // the exit-only buffer: a silently failed event stream must be visible
      // in the control-plane log at the moment it happens.
      const now = Date.now();
      const last = this.stderrLogAt.get(process) ?? 0;
      if (now - last >= 2_000) {
        this.stderrLogAt.set(process, now);
        this.log("warn", `Pi runtime stderr: ${cap(chunk, 500).trimEnd()}`);
      }
    });
    process.on("malformed", (line: string) => {
      const sessionId = options.activeSessionId();
      if (sessionId) void this.publish(cwd, sessionId, { type: "error", sessionId, message: `Malformed Pi RPC output: ${cap(line, 500)}`, recoverable: true }).catch((error: unknown) => {
        this.log("warn", `Failed to publish malformed-output event: ${String(error)}`);
      });
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
          if (normalized.type === "text.updated") {
            await this.queueText(cwd, sessionId, normalized);
          } else {
            await this.flushPendingText(cwd, sessionId);
            await this.publish(cwd, sessionId, normalized);
          }
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
      }).catch((error: unknown) => {
        this.log("warn", `Failed to publish unexpected Pi exit: ${String(error)}`);
      });
    });
  }

  async subscribe(
    cwd: string,
    sessionId: string,
    lastEventId: string | undefined,
    deliver: (record: SseEventRecord) => unknown,
    replay = true,
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
    const records = replay ? await this.eventStore.readAfter(cwd, sessionId, lastEventId) : [];
    for (const record of records) {
      if (!send(record)) return unsubscribe;
    }
    // A page refresh has no in-memory SSE cursor. Re-deliver interactions that
    // are still waiting for a browser response so the UI can reconstruct the
    // prompt without replaying the whole durable conversation.
    const pendingInteraction = this.pendingInteractions.get(key);
    if (pendingInteraction) {
      for (const record of pendingInteraction) {
        if (!send(record)) return unsubscribe;
      }
    }
    subscriber.ready = true;
    for (const record of subscriber.pending) {
      if (!send(record)) return unsubscribe;
    }
    subscriber.pending.length = 0;
    subscriber.delivered.clear();
    return unsubscribe;
  }

  publish(cwd: string, sessionId: string, payload: Record<string, unknown>, guard?: EventPublishGuard): Promise<void> {
    const key = streamKey(cwd, sessionId);
    const previous = this.publishing.get(key) ?? Promise.resolve();
    const canPublish = () => guard?.() !== false;
    const next = previous.catch(() => undefined).then(async () => {
      if (!canPublish()) return;
      await this.ensureSequence(cwd, sessionId, key);
      if (!canPublish()) return;
      const sequence = (this.sequences.get(key) ?? 0) + 1;
      this.sequences.set(key, sequence);
      const record: SseEventRecord = {
        event: String(payload.type ?? "runtime.event"),
        id: String(sequence),
        data: JSON.stringify(safeValue(payload)),
        created_at: new Date().toISOString(),
      };
      let appended = true;
      try {
        appended = guard && this.eventStore.appendConditional
          ? await this.eventStore.appendConditional(cwd, sessionId, record, guard)
          : (await this.eventStore.append(cwd, sessionId, record), canPublish());
      } catch {
        // Live delivery must survive a persistence outage, but a conditional
        // event must never be sent after its generation has been invalidated.
        appended = canPublish();
      }
      if (!appended || !canPublish()) {
        if (this.sequences.get(key) === sequence) this.sequences.set(key, sequence - 1);
        return;
      }
      const type = String(payload.type ?? "");
      if (type === "questionnaire.asked") {
        this.pendingInteractions.set(key, [record]);
      } else if (type === "question.asked" && payload.questionnaire === true) {
        const pending = this.pendingInteractions.get(key) ?? [];
        const questionnaire = pending.find((candidate) => {
          const candidatePayload = recordPayload(candidate);
          return candidatePayload?.type === "questionnaire.asked"
            && candidatePayload.toolCallId === payload.toolCallId;
        });
        this.pendingInteractions.set(key, questionnaire ? [questionnaire, record] : [record]);
      } else if (type === "question.asked" || type === "permission.asked") {
        this.pendingInteractions.set(key, [record]);
      } else if (type === "questionnaire.finished" || type === "agent_settled" || type === "session.idle") {
        this.pendingInteractions.delete(key);
      }
      for (const subscriber of this.subscribers.get(key) ?? []) {
        if (!canPublish()) return;
        if (subscriber.cancelled) continue;
        if (subscriber.ready) {
          if (!canPublish()) return;
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

  private async ensureSequence(cwd: string, sessionId: string, key: string): Promise<void> {
    if (this.sequences.has(key) || !this.eventStore.nextSequence) return;
    const existing = this.sequenceInitializers.get(key);
    if (existing) return existing;
    let initialization!: Promise<void>;
    initialization = Promise.resolve(this.eventStore.nextSequence(cwd, sessionId)).then((sequence) => {
      const current = this.sequences.get(key) ?? 0;
      if (Number.isSafeInteger(sequence) && sequence >= 0) this.sequences.set(key, Math.max(current, sequence));
    }).catch(() => undefined).finally(() => {
      if (this.sequenceInitializers.get(key) === initialization) this.sequenceInitializers.delete(key);
    });
    this.sequenceInitializers.set(key, initialization);
    return initialization;
  }

  private async queueText(cwd: string, sessionId: string, payload: Record<string, unknown>): Promise<void> {
    const key = streamKey(cwd, sessionId);
    const existing = this.pendingText.get(key);
    if (existing && existing.payload.partId !== payload.partId) await this.flushPendingText(cwd, sessionId);
    const current = this.pendingText.get(key);
    if (current) {
      const incomingText = String(payload.text ?? "");
      if (payload.replace === true) {
        current.payload = { ...current.payload, ...payload, text: cap(incomingText) };
      } else {
        current.payload = {
          ...current.payload,
          ...payload,
          text: cap(`${String(current.payload.text ?? "")}${incomingText}`),
          ...(current.payload.replace === true ? { replace: true } : {}),
        };
      }
      return;
    }
    const pending: PendingText = {
      cwd,
      sessionId,
      payload: { ...payload, text: cap(payload.text) },
      timer: setTimeout(() => {
        void this.flushPendingText(cwd, sessionId).catch(() => undefined);
      }, TEXT_BATCH_MS),
    };
    this.pendingText.set(key, pending);
  }

  private async flushPendingText(cwd: string, sessionId: string): Promise<void> {
    const key = streamKey(cwd, sessionId);
    const pending = this.pendingText.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingText.delete(key);
    await this.publish(cwd, sessionId, pending.payload);
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
      if (text.snapshot !== undefined) {
        if (text.snapshot === accumulated) emitted = "";
        else if (text.snapshot.startsWith(accumulated)) emitted = text.snapshot.slice(accumulated.length);
        else if (accumulated) {
          emitted = text.snapshot;
          replace = true;
        } else {
          emitted = text.snapshot;
        }
        turn.textByKey.set(key, text.snapshot);
        if (text.type === "text_end" && !text.messageId) turn.activeAnonymousKey = null;
      } else if (text.type === "text_end") {
        if (text.text === accumulated) emitted = "";
        else if (text.text.startsWith(accumulated)) emitted = text.text.slice(accumulated.length);
        else if (accumulated) replace = true;
        turn.textByKey.set(key, text.text);
        if (!text.messageId) turn.activeAnonymousKey = null;
      } else {
        // Pi may emit the complete accumulated text in text_delta events.
        // Treat that form as a replacement and only emit the new suffix;
        // genuine deltas continue to be appended.
        if (accumulated && text.text.startsWith(accumulated)) {
          emitted = text.text.slice(accumulated.length);
          turn.textByKey.set(key, text.text);
        } else {
          turn.textByKey.set(key, accumulated + text.text);
        }
      }
      if (text.text.trim() || accumulated.trim()) turn.hadText = true;
      if (!emitted && !replace) return [];
      return [{ type: "text.updated", sessionId, partId: messageKey, text: cap(emitted), ...(text.presentationRole ? { presentationRole: text.presentationRole } : {}), ...(replace ? { replace: true } : {}) }];
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
        const presentationRole = message?.presentationRole === "final" || message?.presentationRole === "intermediate" ? message.presentationRole : undefined;
        return [{ type: "text.updated", sessionId, partId, text: "", ...(presentationRole ? { presentationRole } : {}) }];
      }
      case "tool_execution_start": {
        turn.hadActivity = true;
        const callId = String(event.toolCallId ?? "");
        const tool = String(event.toolName ?? "unknown");
        const records: Record<string, unknown>[] = [];
        if (tool === "ask_user_question") {
          const questionnaire = questionnairePayload(sessionId, callId, event.args);
          if (questionnaire) records.push(questionnaire);
        }
        const title = toolActivityTitle(tool, event.args);
        const presentation = event.presentation && typeof event.presentation === "object" ? event.presentation : toolActivityPresentation(tool, event.args);
        records.push({ type: "tool.updated", sessionId, callId, tool, status: "running", ...(title ? { title } : {}), ...(presentation ? { presentation } : {}), input: safeValue(event.args ?? {}), startedAt: new Date().toISOString() });
        return records;
      }
      case "tool_execution_update":
        turn.hadActivity = true;
        return [{ type: "tool.updated", sessionId, callId: String(event.toolCallId ?? ""), tool: String(event.toolName ?? ""), status: "running", partialOutput: cap(event.partialResult) }];
      case "tool_execution_end": {
        turn.hadActivity = true;
        const callId = String(event.toolCallId ?? "");
        const tool = String(event.toolName ?? "");
        const records: Record<string, unknown>[] = [];
        if (tool === "ask_user_question") records.push({ type: "questionnaire.finished", sessionId, toolCallId: callId, cancelled: event.isError === true });
        const presentation = event.presentation && typeof event.presentation === "object" ? event.presentation : toolActivityPresentation(tool, event.args);
        records.push({ type: "tool.updated", sessionId, callId, tool, status: event.isError ? "error" : "done", output: cap(event.result), ...(presentation ? { presentation } : {}), ...(event.details === undefined ? {} : { details: safeValue(event.details) }), endedAt: new Date().toISOString() });
        return records;
      }
      case "extension_ui_request": {
        turn.hadActivity = true;
        const method = String(event.method ?? "");
        if (method === "confirm") return [{ type: "permission.asked", sessionId, requestId: String(event.id ?? ""), title: String(event.title ?? "Confirmation"), message: cap(event.message) }];
        if (["select", "input", "editor"].includes(method)) {
          const toolCallId = browserQuestionnaireRequestId(event.title);
          return [{
            type: "question.asked",
            sessionId,
            requestId: String(event.id ?? ""),
            method,
            title: toolCallId ? "Questionnaire" : String(event.title ?? "Question"),
            message: cap(toolCallId ? "Complete the questionnaire to continue." : event.message),
            options: safeValue(event.options ?? []),
            placeholder: String(event.placeholder ?? ""),
            prefill: String(event.prefill ?? ""),
            ...(toolCallId ? { questionnaire: true, toolCallId } : {}),
          }];
        }
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
