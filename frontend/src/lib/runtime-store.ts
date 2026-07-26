/** Agent Runtime Store — manages pi agent session state.
 *
 *  The implementation lives in ./agent-runtime/*: the store instance (store.ts),
 *  its actions (session-actions.ts), transport event folding (event-fold.ts),
 *  REST recovery paths (recovery.ts), session naming (naming.ts) and the SSE
 *  subscription (listener.ts). This module re-exports the public surface
 *  unchanged. */

export { useRuntimeStore } from "./agent-runtime/store";
export { applySessionReplacements } from "./agent-runtime/session-replacement";
export { convertHistoryToBlocks } from "./agent-runtime/event-fold";
export type { PendingInteraction, RuntimeState, SessionReplacement } from "./agent-runtime/types";
