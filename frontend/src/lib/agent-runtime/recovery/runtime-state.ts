/** Authoritative busy/idle observations and conservative lifecycle reconciliation. */
import { getClient, type PiScienceClient, type SessionState } from "../../client/pi-science-client";
import type { Thread } from "../folding/types";
import { markWorkspaceFilesChanged } from "../file-revision";
import { generations } from "../generations";
import { runtimeStore } from "../store-access";
import { hasActivePendingInteraction, hasPendingInteractionData, type RuntimeState } from "../types";
import { buildTurnPresentations, type TurnLifecycle } from "../../conversation/turn-presentation";
import type { KnownRuntimeState } from "./types";
import { runtimeBusy, runtimeKey } from "./identity";
import { waitForRecovery } from "./timing";

const WORKING_STATE_MAX_ATTEMPTS = 3;

const WORKING_STATE_BACKOFF_MS = [0, 100, 250] as const;

const knownRuntimeStates = new WeakMap<PiScienceClient, Map<string, KnownRuntimeState>>();

const suppressedConnectionRecoveries = new WeakMap<PiScienceClient, Set<string>>();

export function rememberRuntimeState(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  runtimeState: SessionState,
  activityGeneration = generations.activity,
): void {
  const states = knownRuntimeStates.get(client) ?? new Map<string, KnownRuntimeState>();
  states.set(runtimeKey(sessionId, cwd), { busy: runtimeBusy(runtimeState), activityGeneration });
  knownRuntimeStates.set(client, states);
}

export function knownRuntimeState(client: PiScienceClient, sessionId: string, cwd: string): KnownRuntimeState | undefined {
  return knownRuntimeStates.get(client)?.get(runtimeKey(sessionId, cwd));
}

export function suppressConnectionRecovery(client: PiScienceClient, sessionId: string, cwd: string): void {
  const suppressed = suppressedConnectionRecoveries.get(client) ?? new Set<string>();
  suppressed.add(runtimeKey(sessionId, cwd));
  suppressedConnectionRecoveries.set(client, suppressed);
}

export function consumeSuppressedConnectionRecovery(client: PiScienceClient, sessionId: string, cwd: string): boolean {
  const suppressed = suppressedConnectionRecoveries.get(client);
  if (!suppressed?.delete(runtimeKey(sessionId, cwd))) return false;
  if (suppressed.size === 0) suppressedConnectionRecoveries.delete(client);
  return true;
}

/** Idle confirms availability, not success. Keep the owned turn's explicit
 * outcome, or a terminal result already observed before the REST snapshot. */
export function confirmedIdleLifecycle(thread: Thread, previous: TurnLifecycle): TurnLifecycle {
  const turns = buildTurnPresentations(thread.blocks);
  const owner = thread.foldState?.activeTurnId;
  const turn = (owner ? turns.find((candidate) => candidate.blocks.some((block) => "turnId" in block && block.turnId === owner)) : undefined) ?? turns.at(-1);
  if (turn?.lifecycle === "failed" || turn?.lifecycle === "aborted") return turn.lifecycle;
  return previous === "failed" || previous === "aborted" ? previous : "settled";
}

export function restoredActivityState(runtimeState: SessionState, current: RuntimeState, thread = current.thread): Pick<RuntimeState, "working" | "turnLifecycle"> {
  if (hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
    return { working: !hasActivePendingInteraction(current.pendingInteraction, current.pendingQuestionnaire), turnLifecycle: "waiting" };
  }
  const streaming = runtimeState.is_streaming || runtimeState.is_compacting;
  const queued = runtimeState.pending_message_count > 0;
  return {
    working: streaming || queued,
    turnLifecycle: streaming ? "active" : queued ? "queued" : confirmedIdleLifecycle(thread, current.turnLifecycle),
  };
}

export function applyRuntimeState(runtimeState: SessionState, current = runtimeStore.getState()): void {
  runtimeStore.setState({
    ...restoredActivityState(runtimeState, current),
    model: runtimeState.model ?? current.model,
    thinking: runtimeState.thinking ?? current.thinking,
    contextTokens: runtimeState.context_tokens ?? current.contextTokens,
    mcpDiagnostics: runtimeState.mcp_diagnostics ?? [],
    contextWindow: runtimeState.context_window ?? current.contextWindow,
    contextPercent: runtimeState.context_percent ?? current.contextPercent,
    compactionEnabled: runtimeState.compaction_enabled ?? current.compactionEnabled,
    compactionThresholdPercent: runtimeState.compaction_threshold_percent ?? current.compactionThresholdPercent,
  });
}

export async function reconcileWorkingState(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  connectionGeneration: number,
  activityGeneration: number,
): Promise<void> {
  const localMutationGeneration = generations.localMutation;
  for (let attempt = 0; attempt < WORKING_STATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const runtimeState = await client.getSessionState(sessionId, cwd);
      const current = runtimeStore.getState();
      if (
        connectionGeneration !== generations.connection
        || activityGeneration !== generations.activity
        || localMutationGeneration !== generations.localMutation
        || getClient() !== client
        || current.activeSessionId !== sessionId
        || current.cwd !== cwd
      ) return;
      rememberRuntimeState(client, sessionId, cwd, runtimeState, activityGeneration);
      applyRuntimeState(runtimeState, current);
      return;
    } catch {
      // A state request failure is retryable. It is not evidence of an idle
      // runtime, so do not clear working until a bounded retry gets an
      // authoritative answer (or a same-generation known idle snapshot exists
      // for the final fallback below).
      if (attempt + 1 < WORKING_STATE_MAX_ATTEMPTS) {
        await waitForRecovery(WORKING_STATE_BACKOFF_MS[attempt + 1] ?? WORKING_STATE_BACKOFF_MS.at(-1)!);
      }
    }
  }

  const current = runtimeStore.getState();
  if (
    connectionGeneration !== generations.connection
    || activityGeneration !== generations.activity
    || localMutationGeneration !== generations.localMutation
    || getClient() !== client
    || current.activeSessionId !== sessionId
    || current.cwd !== cwd
  ) return;
  const known = knownRuntimeState(client, sessionId, cwd);
  if (known?.activityGeneration !== activityGeneration) return;
  if (known.busy) {
    // A previous authoritative busy result remains the safe answer when all
    // retry requests fail: never re-enable Send while the runtime may run.
    applyRuntimeState({
      id: sessionId,
      cwd,
      is_streaming: true,
      is_compacting: false,
      pending_message_count: 0,
    }, current);
  } else if (!hasPendingInteractionData(current.pendingInteraction, current.pendingQuestionnaire)) {
    // Only an authoritative idle snapshot from this activity generation may
    // settle a failed probe. An unknown state must remain conservatively busy.
    runtimeStore.setState({ working: false, turnLifecycle: confirmedIdleLifecycle(current.thread, current.turnLifecycle) });
    markWorkspaceFilesChanged();
  }
}
