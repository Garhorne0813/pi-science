

export type KnownRuntimeState = { busy: boolean; activityGeneration: number };

/** What a recovery run has been asked to do. A transport loss is verified at
 *  once, while a restore keeps watching an authoritative busy snapshot until
 *  the composer is free. Both can be outstanding at once, because a loss does
 *  not retire the restore's duty, and the run ends only when the set empties. */
export type RecoveryKind = "restore" | "connection-loss";

export type ConnectionRecoveryRun = {
  connectionGeneration: number;
  activityGeneration: number;
  localMutationGeneration: number;
  demands: Set<RecoveryKind>;
  /** Set while the worker sleeps, so a demand joining mid-run cuts the wait. */
  wake: (() => void) | null;
  promise: Promise<void>;
};

export type GapRecoveryResult = "completed" | "superseded" | "aborted" | "retryable-failure";

export interface GapRecoveryRun {
  promise: Promise<void>;
  rerunRequested: boolean;
  rounds: number;
  resetTransport: boolean;
  reconnectTransport: boolean;
}
