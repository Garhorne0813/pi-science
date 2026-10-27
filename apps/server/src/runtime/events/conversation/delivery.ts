import type { SseEventRecord } from "../event-store.js";
import type { Subscriber, EventStore } from "./types.js";
import { MAX_SUBSCRIBER_REPLAY_PENDING } from "./limits.js";
import { streamKey, recordKey, recordPayload } from "./records.js";

export class ConversationDelivery {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly pendingInteractions = new Map<string, SseEventRecord[]>();
  constructor(private readonly eventStore: EventStore) {}
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
        (payload?.type === "interaction.requested")
        && payload.requestId === requestId
      ));
    const toolCallId = request?.questionnaire === true && typeof request.toolCallId === "string"
      ? request.toolCallId
      : null;
    const remaining = pending.filter((record) => {
      const payload = recordPayload(record);
      if (!payload) return true;
      if (
        (payload.type === "interaction.requested")
        && payload.requestId === requestId
      ) return false;
      if (toolCallId !== null && payload.type === "questionnaire.asked" && payload.toolCallId === toolCallId) return false;
      return true;
    });
    if (remaining.length > 0) this.pendingInteractions.set(key, remaining);
    else this.pendingInteractions.delete(key);
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
  deliver(key: string, payload: Record<string, unknown>, record: SseEventRecord, canPublish: () => boolean): boolean {
    const type = String(payload.type ?? "");
    if (type === "questionnaire.asked" || type === "interaction.requested") {
      const pending = this.pendingInteractions.get(key) ?? [];
      // Parallel tool calls can each wait for browser input. Keep every
      // unresolved request so a fresh browser attachment restores the queue.
      const remaining = pending.filter((candidate) => {
        const previous = recordPayload(candidate);
        if (previous?.type !== type) return true;
        return type === "questionnaire.asked"
          ? previous.toolCallId !== payload.toolCallId
          : previous.requestId !== payload.requestId;
      });
      this.pendingInteractions.set(key, [...remaining, record]);
    } else if (type === "questionnaire.finished") {
      const remaining = (this.pendingInteractions.get(key) ?? []).filter((candidate) => {
        const previous = recordPayload(candidate);
        return previous?.toolCallId !== payload.toolCallId;
      });
      if (remaining.length) this.pendingInteractions.set(key, remaining);
      else this.pendingInteractions.delete(key);
    } else if (type === "operation.settled") {
      this.pendingInteractions.delete(key);
    }
    for (const subscriber of this.subscribers.get(key) ?? []) {
      if (!canPublish()) return false;
      if (subscriber.cancelled) continue;
      if (subscriber.ready) {
        if (!canPublish()) return false;
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
    return true;
  }
}
