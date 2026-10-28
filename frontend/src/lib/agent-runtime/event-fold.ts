/** Stable folding API. Implementations are isolated by projection responsibility. */
export type { Thread, EventFoldState } from "./folding/types";
export { emptyThread, resetTurnBuffer, resetThreadProjection } from "./folding/state";
export { foldEvent } from "./folding/reducer";
export { threadFromMessages, convertHistoryToBlocks } from "./folding/history-conversion";
export { prependHistoryMessages, replaceHistoryTail, mergeHistoryWindow, mergeHistoryWithLive } from "./folding/history-window";
export type { HistoryWindowMerge } from "./folding/history-window";
export { attachTurnArtifacts } from "./folding/artifacts";
export type { ArtifactAttachOptions } from "./folding/artifacts";
