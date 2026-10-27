import { randomUUID } from "node:crypto";
import type { StreamIdentityState, ConversationEventHubOptions } from "./types.js";
import { streamKey } from "./records.js";

export class ConversationStreams {
  private readonly streamIdentities = new Map<string, StreamIdentityState>();
  constructor(private readonly options: ConversationEventHubOptions) {}
  get(cwd: string, sessionId: string): StreamIdentityState {
    const key = streamKey(cwd, sessionId);
    const existing = this.streamIdentities.get(key);
    if (existing) return existing;
    const created = { epoch: this.options.createStreamEpoch?.() || randomUUID(), nextSequence: 0, tainted: false };
    this.streamIdentities.set(key, created);
    return created;
  }
}
