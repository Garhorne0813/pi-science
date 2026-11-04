import type { ProductInput } from "../product-input.js";
import type { EventPublishGuard, SseEventRecord } from "../event-store.js";

/** Why delivery gave up on a subscriber. The owner of the consumer (the SSE
 *  route) needs this: without it a subscriber can be dropped while its HTTP
 *  response stays open and heartbeats keep the connection looking healthy. */
export type SubscriberAbandonReason = "delivery_failed" | "replay_backlog_overflow";

export type Subscriber = {
  ready: boolean;
  pending: SseEventRecord[];
  delivered: Set<string>;
  cancelled: boolean;
  deliver: (record: SseEventRecord) => unknown;
  abandon?: (reason: SubscriberAbandonReason) => void;
};

export type EventStore = {
  append(cwd: string, sessionId: string, event: SseEventRecord): Promise<void>;
  appendConditional?: (cwd: string, sessionId: string, event: SseEventRecord, guard: EventPublishGuard) => Promise<boolean>;
  readAfter(cwd: string, sessionId: string, lastEventId?: string | null): Promise<SseEventRecord[]>;
  nextSequence?: (cwd: string, sessionId: string) => Promise<number>;
};

export type StreamIdentityState = {
  epoch: string;
  nextSequence: number;
  tainted: boolean;
};

export type ConversationEventHubOptions = {
  createStreamEpoch?: () => string;
};

export type BindingOptions = {
  activeSessionId: () => string | null;
  onBusy: (busy: boolean) => void;
  onExit: () => void;
  observe?: (event: ProductInput, sessionId: string, identity: { turnId: string; turnOrdinal: number } | undefined) => Promise<void> | void;
};

export type TurnState = {
  hadText: boolean;
  hadError: boolean;
  lastRuntimeError?: string;
  hadActivity: boolean;
  /** Accumulated assistant content deltas keyed by `${messageKey}:${contentIndex}`.
   *  Text and thinking parts share the map: the content index is unique per part. */
  contentByKey: Map<string, string>;
  revisionByKey: Map<string, number>;
  anonymousSerial: number;
  activeAnonymousKey: string | null;
  turnOrdinal: number;
  turnId: string | null;
  runId: string | null;
  streamEpoch: string;
};

export type StderrChunk = { text: string; at: number; turn: number };

export type PendingText = {
  cwd: string;
  sessionId: string;
  payload: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
};

// Keep the durable event payload bounded, but large answers/logs must remain
// recoverable. The UI owns the 8KB preview; the transport should not silently
// turn a 100KB answer into a clipped message.

export type HubLogger = (level: "info" | "warn" | "error", message: string) => void;
