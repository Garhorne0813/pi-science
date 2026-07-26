/** Cross-module coordination state for the runtime store's async paths.
 *
 *  These counters were module-level `let`s in runtime-store.ts. They stay
 *  mutable and process-global (one runtime store per app) — each async result
 *  compares the generation it captured with the current one and drops itself
 *  when the two differ:
 *   - `connection`: bumped on every connect/reconnect/session replacement.
 *   - `activity`: bumped by any live event or local action, so a stale REST
 *     snapshot cannot clear a turn that is demonstrably alive.
 *   - `localMutation`: bumped by user-initiated mutations (prompt, model,
 *     abort) so an in-flight history read cannot overwrite optimistic blocks.
 *   - `promptMonitor`: bumped when the late-stream prompt monitor must stop.
 *  `turnState.errored` records whether the turn in flight ended in a
 *  non-recoverable error, so `session.idle` can settle to error instead of ready. */

export const generations = {
  connection: 0,
  activity: 0,
  localMutation: 0,
  promptMonitor: 0,
};

export const turnState = { errored: false };
