import type { AssistantContentKind } from "../assistant-content.js";
import type { PendingText } from "./types.js";
import { MAX_EVENT_TEXT, TEXT_BATCH_MS } from "./limits.js";
import { capUtf8 } from "./text.js";
import { streamKey } from "./records.js";
import { matchesWorkspace } from "./records.js";

/** Keep text/thinking slots separate; flush them before any non-content event. */
export class ConversationTextBatch {
  private readonly pendingText = new Map<string, PendingText>();
  constructor(private readonly publish: (cwd: string, sessionId: string, payload: Record<string, unknown>) => Promise<void>) {}
  pending(cwd?: string): PendingText[] {
    return [...this.pendingText.values()].filter((item) => matchesWorkspace(streamKey(item.cwd, item.sessionId), cwd));
  }
  async queueText(cwd: string, sessionId: string, payload: Record<string, unknown>, kind: AssistantContentKind): Promise<void> {
    // Text and thinking stream in parallel within one message; separate
    // pending slots keep their payloads from coalescing into each other.
    const key = `${streamKey(cwd, sessionId)}\0${kind}`;
    const existing = this.pendingText.get(key);
    if (existing && existing.payload.partId !== payload.partId) await this.flushPendingText(cwd, sessionId);
    const current = this.pendingText.get(key);
    if (current) {
      const incomingText = String(payload.text ?? "");
      if (payload.replace === true) {
        current.payload = { ...current.payload, ...payload, text: capUtf8(incomingText, MAX_EVENT_TEXT).text };
      } else {
        current.payload = {
          ...current.payload,
          ...payload,
          text: capUtf8(`${String(current.payload.text ?? "")}${incomingText}`, MAX_EVENT_TEXT).text,
          ...(current.payload.baseRevision !== undefined ? { baseRevision: current.payload.baseRevision } : {}),
          ...(current.payload.replace === true ? { replace: true } : {}),
        };
      }
      return;
    }
    const pending: PendingText = {
      cwd,
      sessionId,
      payload: { ...payload, text: capUtf8(payload.text, MAX_EVENT_TEXT).text },
      timer: setTimeout(() => {
        void this.flushPendingText(cwd, sessionId).catch(() => undefined);
      }, TEXT_BATCH_MS),
    };
    this.pendingText.set(key, pending);
  }
  async flushPendingText(cwd: string, sessionId: string): Promise<void> {
    const prefix = `${streamKey(cwd, sessionId)}\0`;
    const keys = [...this.pendingText.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      const pending = this.pendingText.get(key)!;
      clearTimeout(pending.timer);
      this.pendingText.delete(key);
      await this.publish(cwd, sessionId, pending.payload);
    }
  }
}
