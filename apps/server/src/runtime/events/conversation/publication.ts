import { randomUUID } from "node:crypto";
import type { EventPublishGuard, SseEventRecord } from "../event-store.js";
import type { EventStore, ConversationEventHubOptions } from "./types.js";
import { streamKey, versionedPayload, chunkTextPayload } from "./records.js";
import { ConversationStreams } from "./streams.js";
import { ConversationProjection } from "./projection.js";
import { ConversationDelivery } from "./delivery.js";
import type { HubLogger } from "./types.js";
import { matchesWorkspace } from "./records.js";

/** Serialize durable appends before live delivery and own stream failure epochs. */
export class ConversationPublication {
  private readonly publishing = new Map<string, Promise<void>>();
  constructor(private readonly eventStore: EventStore, private readonly options: ConversationEventHubOptions,
    private readonly streams: ConversationStreams, private readonly projection: ConversationProjection,
    private readonly delivery: ConversationDelivery, private readonly log: HubLogger) {}
  pending(cwd?: string): Promise<void>[] {
    return [...this.publishing].filter(([key]) => matchesWorkspace(key, cwd)).map(([, promise]) => promise);
  }
  async latestCursor(cwd: string, sessionId: string): Promise<string | null> {
    const records = await this.eventStore.readAfter(cwd, sessionId);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const id = records[index]?.id;
      if (id) return id;
    }
    return null;
  }
  publish(cwd: string, sessionId: string, payload: Record<string, unknown>, guard?: EventPublishGuard): Promise<void> {
    const key = streamKey(cwd, sessionId);
    const previous = this.publishing.get(key) ?? Promise.resolve();
    const canPublish = () => guard?.() !== false;
    const next = previous.catch(() => undefined).then(async () => {
      for (const chunk of chunkTextPayload(payload)) {
        const outcome = await this.publishOne(cwd, sessionId, key, chunk, guard);
        if (outcome === "cancelled" || outcome === "persistence-failed") return;
        if (!canPublish()) return;
      }
    });
    this.publishing.set(key, next);
    void next.then(() => {
      if (this.publishing.get(key) === next) this.publishing.delete(key);
    }, () => { if (this.publishing.get(key) === next) this.publishing.delete(key); });
    return next;
  }
  private async publishOne(
    cwd: string,
    sessionId: string,
    key: string,
    payload: Record<string, unknown>,
    guard?: EventPublishGuard,
  ): Promise<"delivered" | "cancelled" | "persistence-failed"> {
    const canPublish = () => guard?.() !== false;
    if (!canPublish()) return "cancelled";
    const identity = this.streams.get(cwd, sessionId);
    if (identity.tainted) {
      identity.epoch = this.options.createStreamEpoch?.() || randomUUID();
      identity.nextSequence = 0;
      identity.tainted = false;
      this.projection.rotateEpoch(key, identity.epoch);
      this.log("warn", `Rotated conversation stream epoch after persistence failure for ${sessionId}`);
    }
    const sequence = identity.nextSequence + 1;
    identity.nextSequence = sequence;
    const eventPayload = versionedPayload(cwd, sessionId, payload, sequence, identity.epoch);
    const record: SseEventRecord = {
      event: String(payload.type ?? "runtime.event"),
      id: `${identity.epoch}:${sequence}`,
      data: JSON.stringify(eventPayload),
      created_at: new Date().toISOString(),
    };
    let persisted = false;
    let persistenceFailed = false;
    try {
      persisted = guard && this.eventStore.appendConditional
        ? await this.eventStore.appendConditional(cwd, sessionId, record, guard)
        : (await this.eventStore.append(cwd, sessionId, record), true);
    } catch (error) {
      // A live event may still be useful during a transient persistence outage,
      // but the next event must start a new epoch so the missing record cannot
      // be mistaken for a durable contiguous prefix after reconnect.
      persistenceFailed = true;
      identity.tainted = true;
      this.log("warn", `Conversation event persistence failed for ${sessionId} at ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
      persisted = false;
    }
    if (!persisted && !persistenceFailed) {
      // A conditional append that observes an invalidated generation did not
      // consume a durable cursor. It is safe to reuse this sequence.
      if (identity.nextSequence === sequence) identity.nextSequence = sequence - 1;
      return "cancelled";
    }
    if (!canPublish()) return "cancelled";
    if (!this.delivery.deliver(key, payload, record, canPublish)) return "cancelled";
    return persistenceFailed ? "persistence-failed" : "delivered";
  }
}
