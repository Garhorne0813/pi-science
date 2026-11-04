import type { SseEventRecord } from "../event-store.js";
import type { Subscriber, SubscriberAbandonReason, EventStore } from "./types.js";
import { MAX_SUBSCRIBER_REPLAY_PENDING } from "./limits.js";
import { streamKey, recordKey, recordPayload } from "./records.js";

// A replay runs inside one synchronous loop while the response is already
// attached. Without a yield the Readable's consumer never gets a turn to
// drain, so `blocked` stays set once the first 64KB is handed over and every
// later record lands in the route's pending buffer: a healthy client
// reconnecting to a long conversation would be told the replay overflowed
// even though it could have consumed all of it. Yield by bytes as well as by
// count (a page of large tool results must still reach a fast consumer) so the
// 512-record/512KB caps keep measuring the real backlog; a genuinely slow
// consumer keeps filling them and still gets the explicit gap.
const REPLAY_YIELD_BYTES = 32 * 1024;
const REPLAY_YIELD_RECORDS = 128;

export class ConversationDelivery {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly pendingInteractions = new Map<string, SseEventRecord[]>();
  constructor(private readonly eventStore: EventStore) {}
  pendingInteraction(cwd: string, sessionId: string, requestId: string): Record<string, unknown> | undefined {
    return this.pendingInteractions.get(streamKey(cwd, sessionId))?.map(recordPayload)
      .find((payload) => payload?.type === "interaction.requested" && payload.requestId === requestId) ?? undefined;
  }
  hasSubscribers(cwd: string, sessionId: string): boolean {
    return (this.subscribers.get(streamKey(cwd, sessionId))?.size ?? 0) > 0;
  }
  resolvePendingInteraction(cwd: string, sessionId: string, requestId: string): void {
    this.resolveInteraction(streamKey(cwd, sessionId), requestId);
  }
  private resolveInteraction(key: string, requestId: string): void {
    if (!requestId) return;
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
    onAbandon?: (reason: SubscriberAbandonReason) => void,
  ): Promise<() => void> {
    const key = streamKey(cwd, sessionId);
    const subscriber: Subscriber = { ready: false, pending: [], delivered: new Set(), cancelled: false, deliver, abandon: onAbandon };
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
    const abandon = (reason: SubscriberAbandonReason): void => {
      if (subscriber.cancelled) return;
      this.abandonSubscriber(key, subscriber, reason);
    };
    const send = (record: SseEventRecord): boolean => {
      if (subscriber.cancelled) return false;
      const identity = recordKey(record);
      if (subscriber.delivered.has(identity)) return true;
      subscriber.delivered.add(identity);
      if (deliver(record) === false) {
        abandon("delivery_failed");
        return false;
      }
      return true;
    };
    const records = replay ? await this.eventStore.readAfter(cwd, sessionId, lastEventId) : [];
    // Let the already-attached response drain during a long replay. The caps in
    // the SSE route must bound what the consumer has not taken yet, not how
    // fast this loop can hand records over: without the turn below a healthy
    // reconnect streams nothing for the whole replay and then reports
    // `replay_overflow`.
    let replayedBytes = 0;
    let replayedRecords = 0;
    for (const record of records) {
      if (!send(record)) return unsubscribe;
      replayedBytes += Buffer.byteLength(record.data);
      replayedRecords += 1;
      if (replayedBytes >= REPLAY_YIELD_BYTES || replayedRecords >= REPLAY_YIELD_RECORDS) {
        replayedBytes = 0;
        replayedRecords = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
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
  /** Delivery, not the consumer, decided this subscriber is gone. Tell the
   *  consumer: it owns the socket and can only close it (or hand the client a
   *  cursor rebase) if it hears about it. */
  private abandonSubscriber(key: string, subscriber: Subscriber, reason: SubscriberAbandonReason): void {
    if (subscriber.cancelled) return;
    subscriber.cancelled = true;
    subscriber.pending.length = 0;
    const set = this.subscribers.get(key);
    set?.delete(subscriber);
    if (set && set.size === 0) this.subscribers.delete(key);
    try { subscriber.abandon?.(reason); }
    catch { /* a consumer callback must never break event delivery */ }
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
    } else if (type === "interaction.resolved") {
      this.resolveInteraction(key, String(payload.requestId ?? ""));
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
        if (subscriber.deliver(record) === false) this.abandonSubscriber(key, subscriber, "delivery_failed");
      } else if (subscriber.pending.length >= MAX_SUBSCRIBER_REPLAY_PENDING) {
        this.abandonSubscriber(key, subscriber, "replay_backlog_overflow");
      } else {
        subscriber.pending.push(record);
      }
    }
    return true;
  }
}
