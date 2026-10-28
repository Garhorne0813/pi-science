/** Public agent runtime API. Store composition lives in store.ts; actions,
 * folding, recovery and listening implementations have separate ownership.
 * The sibling facade modules retain existing imports for callers and tests. */

export { useRuntimeStore } from "./store";
export { applySessionReplacements } from "./session-replacement";
export { convertHistoryToBlocks, mergeHistoryWindow, replaceHistoryTail, resetThreadProjection } from "./event-fold";
export type { HistoryWindowMerge } from "./event-fold";
export type {
  PendingInteraction,
  PendingQuestionnaire,
  QuestionnaireOption,
  QuestionnaireQuestion,
  RuntimeState,
  SessionReplacement,
} from "./types";
