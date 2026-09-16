/** Cross-module coordination state for the runtime store's async paths.
 *
 *  These counters were module-level `let`s in runtime-store.ts. They stay
 *  mutable and process-global (one runtime store per app) — each async result
 *  compares the generation it captured with the current one and drops itself
 *  when the two differ:
 *   - `connection`: bumped on every connect/reconnect/session replacement.
 *   - `conversation`: bumped by message/run activity and authoritative
 *     recovery boundaries. It invalidates settled-history and projection work.
 *   - `activity`: the legacy fine-grained activity counter, retained for
 *     existing async guards and compatibility with older call sites.
 *   - `presentationMetadata`: bumped by artifacts/stats-only updates. Those
 *     updates may refresh metadata without cancelling a settled resync.
 *   - `localMutation`: bumped by user-initiated mutations (prompt, model,
 *     abort) so an in-flight history read cannot overwrite optimistic blocks.
 *   - `historyWindow`: bumped when pagination prepends an older page, so an
 *     asynchronous recovery probe cannot replace the newly expanded window.
 *   - `promptMonitor`: bumped when the late-stream prompt monitor must stop.
 *  `turnState.errored` records whether the turn in flight ended in a
 *  non-recoverable error, so `session.idle` can settle to error instead of ready. */

export const generations = {
  connection: 0,
  conversation: 0,
  activity: 0,
  presentationMetadata: 0,
  localMutation: 0,
  historyWindow: 0,
  promptMonitor: 0,
};

export function bumpConversationGeneration(): number {
  generations.conversation += 1;
  generations.activity += 1;
  return generations.conversation;
}

export function bumpPresentationMetadataGeneration(): number {
  generations.presentationMetadata += 1;
  return generations.presentationMetadata;
}

export const turnState = { errored: false };
