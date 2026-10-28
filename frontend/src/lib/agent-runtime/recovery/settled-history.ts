/** Reconcile settled conversation history without overwriting newer activity or metadata. */
import { getClient } from "../../client/pi-science-client";
import { attachTurnArtifacts } from "../folding/artifacts";
import type { Thread } from "../folding/types";
import { generations } from "../generations";
import { mergeRecoveryHistoryWindow } from "../history-window-recovery";
import { runtimeStore } from "../store-access";
import { fetchPersistedTurnArtifacts, refetchPersistedTurnArtifacts } from "../turn-artifacts";

export async function resyncCompletedHistory(sessionId: string, cwd: string): Promise<void> {
  const generation = generations.connection;
  const conversationGeneration = generations.conversation;
  const activityGeneration = generations.activity;
  const metadataGeneration = generations.presentationMetadata;
  try {
    const client = getClient();
    const [historyResult, artifactsResult] = await Promise.allSettled([
      client.getMessagesPage(sessionId, cwd),
      fetchPersistedTurnArtifacts(sessionId, cwd),
    ]);
    const current = runtimeStore.getState();
    if (historyResult.status !== "fulfilled") return;
    if (
      generation !== generations.connection
      || conversationGeneration !== generations.conversation
      || activityGeneration !== generations.activity
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || current.working
    ) return;
    const history = historyResult.value;
    // Restore the REST snapshot wholesale for a settled conversation. The Pi
    // process writes the session JSONL before operation.settled, so a non-empty
    // snapshot is authoritative. An empty snapshot can still race the flush.
    if (history.messages.length === 0 && current.thread.blocks.length > 0) return;
    let turns = artifactsResult.status === "fulfilled" ? artifactsResult.value : [];
    // A latest page can move completely beyond the already loaded window after
    // a long tool-heavy turn. Walk older pages until lineage is established;
    // only a complete no-overlap history may replace the window wholesale.
    const historyWindowGeneration = generations.historyWindow;
    const merged = await mergeRecoveryHistoryWindow(client, sessionId, cwd, current.thread, history, { keepLiveExtras: false, resetProjection: true });
    let latest = runtimeStore.getState();
    if (
      generation !== generations.connection
      || conversationGeneration !== generations.conversation
      || activityGeneration !== generations.activity
      || historyWindowGeneration !== generations.historyWindow
      || latest.activeSessionId !== sessionId
      || latest.cwd !== cwd
      || latest.working
    ) return;
    // The settle event can precede the messages endpoint's view of the user
    // write. Keep that prompt at its turn boundary while accepting any new
    // assistant/tool records from the snapshot; a later refresh replaces it
    // once the durable user row with the same request identity arrives.
    const restoredThread = retainUnmatchedPrompt(merged.thread, latest.thread);
    if (metadataGeneration !== generations.presentationMetadata) {
      try {
        const persistedTurns = await refetchPersistedTurnArtifacts(sessionId, cwd);
        latest = runtimeStore.getState();
        turns = mergeArtifactTurns(persistedTurns, liveArtifactTurns(latest.thread, sessionId));
      } catch (error) {
        // Conversation history is the primary recovery result. When the
        // metadata refresh is unavailable, use only the latest live summaries:
        // reusing the first (older) snapshot could resurrect a removed strip.
        console.warn("Failed to refresh conversation metadata during history resync:", error);
        latest = runtimeStore.getState();
        turns = liveArtifactTurns(latest.thread, sessionId);
      }
      latest = runtimeStore.getState();
      if (
        generation !== generations.connection
        || conversationGeneration !== generations.conversation
        || activityGeneration !== generations.activity
        || historyWindowGeneration !== generations.historyWindow
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
        || latest.working
      ) return;
    }
    const historyHasMore = merged.retainedOlderPrefix ? latest.historyHasMore : merged.boundaryPage.has_more;
    runtimeStore.setState({
      thread: attachTurnArtifacts(restoredThread, turns, { windowComplete: !historyHasMore }),
      historyCursor: merged.retainedOlderPrefix ? latest.historyCursor : merged.boundaryPage.next_cursor,
      historyHasMore,
      historyLoading: false,
      historySnapshotVersion: history.snapshot_version,
    });
  } catch (error) {
    console.error("Failed to resynchronize completed conversation:", error);
  }
}

function retainUnmatchedPrompt(history: Thread, live: Thread): Thread {
  const promptIndex = live.blocks.findLastIndex((block) => block.kind === "user" && block.client_message_id);
  if (promptIndex < 0) return history;
  const prompt = live.blocks[promptIndex];
  if (prompt.kind !== "user" || history.blocks.some((block) => block.kind === "user"
    && (block.client_message_id === prompt.client_message_id || block.id === prompt.id))) return history;
  const preceding = live.blocks.slice(0, promptIndex).findLast((block) => history.index[block.id] !== undefined);
  const insertAt = preceding ? history.index[preceding.id] + 1 : 0;
  const blocks = [...history.blocks];
  blocks.splice(insertAt, 0, prompt);
  const index: Record<string, number> = {};
  blocks.forEach((block, position) => { index[block.id] = position; });
  return { ...history, blocks, index };
}

function liveArtifactTurns(thread: ReturnType<typeof runtimeStore.getState>["thread"], sessionId: string) {
  return thread.blocks.flatMap((block) => block.kind === "artifact-summary" ? [{
    turn_id: block.turnId,
    session_id: sessionId,
    assistant_message_id: block.assistantMessageId ?? null,
    turn_ordinal: block.turnOrdinal ?? null,
    ended_at: block.endedAt ?? "",
    artifacts: block.artifacts,
  }] : []);
}

export function mergeArtifactTurns(
  persisted: Awaited<ReturnType<typeof fetchPersistedTurnArtifacts>>,
  live: Awaited<ReturnType<typeof fetchPersistedTurnArtifacts>>,
) {
  const byTurn = new Map(persisted.map((turn) => [turn.turn_id, turn]));
  for (const turn of live) {
    const previous = byTurn.get(turn.turn_id);
    // The live turn is newer for its artifact list and ordinal, but a copy
    // rebuilt from a legacy block may carry no turn end time. Letting it
    // replace the persisted copy outright strands the strip: the record has no
    // assistant message id and an opaque turn id, so the end time is the only
    // anchor left, and an unresolvable anchor is dropped from a partial history
    // window instead of being placed by position.
    byTurn.set(
      turn.turn_id,
      previous && !turn.ended_at ? { ...turn, ended_at: previous.ended_at } : turn,
    );
  }
  return [...byTurn.values()];
}
