/** Agent Runtime Store — manages pi agent session state.
 *
 *  The implementation lives in this folder: the store instance (store.ts),
 *  its actions (session-actions.ts), transport event folding (event-fold.ts),
 *  REST recovery paths (recovery.ts), session naming (naming.ts) and the SSE
 *  subscription (listener.ts). This module re-exports the public surface
 *  unchanged. */

export { useRuntimeStore } from "./store";
export { applySessionReplacements } from "./session-replacement";
export { convertHistoryToBlocks } from "./event-fold";
export type {
  PendingInteraction,
  PendingQuestionnaire,
  QuestionnaireOption,
  QuestionnaireQuestion,
  RuntimeState,
  SessionReplacement,
} from "./types";
