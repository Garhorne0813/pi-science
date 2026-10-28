import { durableEventStore, type EventPublishGuard, type SseEventRecord } from "./event-store.js";
import type { RuntimeEventSource } from "../agent/agent-runtime-types.js";
import { ConversationStreams } from "./conversation/streams.js";
import { ConversationProjection } from "./conversation/projection.js";
import { ConversationDelivery } from "./conversation/delivery.js";
import { ConversationPublication } from "./conversation/publication.js";
import { ConversationTextBatch } from "./conversation/text-batch.js";
import { ConversationBindings } from "./conversation/binding.js";
import type { EventStore, ConversationEventHubOptions, BindingOptions, HubLogger } from "./conversation/types.js";

/** Conversation event composition root. Each protocol owns its queues and state. */
export class ConversationEventHub {
  private readonly delivery: ConversationDelivery;
  private readonly publication: ConversationPublication;
  private readonly text: ConversationTextBatch;
  private readonly bindings: ConversationBindings;
  private log: HubLogger = () => {};

  constructor(eventStore: EventStore = durableEventStore, options: ConversationEventHubOptions = {}) {
    const streams = new ConversationStreams(options);
    const projection = new ConversationProjection(streams);
    this.delivery = new ConversationDelivery(eventStore);
    this.publication = new ConversationPublication(eventStore, options, streams, projection, this.delivery, (...args) => this.log(...args));
    this.text = new ConversationTextBatch((...args) => this.publish(...args));
    this.bindings = new ConversationBindings({
      publish: (...args) => this.publish(...args),
      normalize: (...args) => projection.normalize(...args),
      queueText: (...args) => this.text.queueText(...args),
      flushPendingText: (...args) => this.text.flushPendingText(...args),
      log: (...args) => this.log(...args),
    });
  }
  configureLogging(log: HubLogger): void { this.log = log; }
  async flush(cwd?: string): Promise<void> {
    const observations = () => this.bindings.pending(cwd);
    const publications = () => this.publication.pending(cwd);
    const texts = () => this.text.pending(cwd);
    // Exit callbacks enqueue terminal records before the drain snapshot.
    await new Promise<void>((resolve) => setImmediate(resolve));
    do {
      await Promise.allSettled(observations());
      await Promise.all(texts().map((pending) => this.text.flushPendingText(pending.cwd, pending.sessionId)));
      await Promise.allSettled(publications());
    } while (observations().length || publications().length || texts().length);
  }
  expectExit(process: RuntimeEventSource): void { this.bindings.expectExit(process); }
  hasSubscribers(cwd: string, sessionId: string): boolean { return this.delivery.hasSubscribers(cwd, sessionId); }
  latestCursor(cwd: string, sessionId: string): Promise<string | null> { return this.publication.latestCursor(cwd, sessionId); }
  resolvePendingInteraction(cwd: string, sessionId: string, requestId: string): void { this.delivery.resolvePendingInteraction(cwd, sessionId, requestId); }
  bind(cwd: string, process: RuntimeEventSource, options: BindingOptions): void { this.bindings.bind(cwd, process, options); }
  subscribe(cwd: string, sessionId: string, lastEventId: string | undefined, deliver: (record: SseEventRecord) => unknown, replay = true): Promise<() => void> {
    return this.delivery.subscribe(cwd, sessionId, lastEventId, deliver, replay);
  }
  publish(cwd: string, sessionId: string, payload: Record<string, unknown>, guard?: EventPublishGuard): Promise<void> {
    return this.publication.publish(cwd, sessionId, payload, guard);
  }
}
export const conversationEventHub = new ConversationEventHub();
