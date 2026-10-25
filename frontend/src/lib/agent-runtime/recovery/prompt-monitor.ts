/** Late-stream reconciliation confirms the current turn through REST evidence. */
import type { PiScienceClient } from "../../client/pi-science-client";
import { generations } from "../generations";
import { loadSessionsInternal } from "../sessions";
import { runtimeStore } from "../store-access";
import { hasActivePendingInteraction, hasPendingInteractionData } from "../types";
import { confirmedIdleLifecycle } from "./runtime-state";
import { resyncCompletedHistory } from "./settled-history";

/** How many consecutive one-second idle REST rounds with no confirmed reply
 *  before the late-stream monitor gives up and settles the UI anyway. Each
 *  idle round performs a state read and, when idle, an additional messages
 *  read. A finished turn with no output or a wedged agent must not leave Send
 *  disabled forever. */
const DEFAULT_IDLE_LIMIT_TICKS = 120;

export async function reconcilePromptAfterLateStream(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  monitorGeneration: number,
  promptTimestamp?: number,
  idleLimitTicks = DEFAULT_IDLE_LIMIT_TICKS,
  expectedActivityGeneration?: number,
): Promise<void> {
  let ticks = 0;
  let idleTicks = 0;
  let forcedReconnect = false;
  while (true) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    const current = runtimeStore.getState();
    if (
      monitorGeneration !== generations.promptMonitor
      || (expectedActivityGeneration !== undefined && expectedActivityGeneration !== generations.activity)
      || current.activeSessionId !== sessionId
      || current.cwd !== cwd
      || !current.working
    ) return;

    ticks += 1;
    const streamOpen = client.isOpenTo(sessionId, cwd);
    // An OPEN EventSource is not proof that bytes are still flowing: laptops
    // waking from sleep and old-session switches can leave a half-open socket.
    // Probe REST once per second in either connection state. If an apparently
    // open stream has produced no terminal event, rebuild it once with its
    // resume cursor so missed text/tool/idle events can be replayed.
    if (ticks % 4 !== 0) continue;
    if (streamOpen && !forcedReconnect) {
      forcedReconnect = true;
      client.reconnect(sessionId, cwd, "late_stream_probe");
    }

    try {
      const runtimeState = await client.getSessionState(sessionId, cwd);
      const latest = runtimeStore.getState();
      if (
        monitorGeneration !== generations.promptMonitor
        || (expectedActivityGeneration !== undefined && expectedActivityGeneration !== generations.activity)
        || latest.activeSessionId !== sessionId
        || latest.cwd !== cwd
        || !latest.working
      ) return;
      const runtimeWorking = runtimeState.is_streaming
        || runtimeState.is_compacting
        || runtimeState.pending_message_count > 0;
      const pendingInteraction = hasPendingInteractionData(latest.pendingInteraction, latest.pendingQuestionnaire);
      const awaitingUserInput = hasActivePendingInteraction(latest.pendingInteraction, latest.pendingQuestionnaire);
      if (awaitingUserInput) {
        // Pi keeps its stream marked busy while it is paused inside the
        // interaction request. The prompt is the work the user needs to do,
        // so clear the spinner state but keep both pending payloads intact.
        ++generations.activity;
        runtimeStore.setState({ working: false, turnLifecycle: "waiting", status: "ready" });
        return;
      }
      if (pendingInteraction) {
        // The questionnaire payload and its matching extension UI request are
        // delivered as separate events. Keep the turn busy until the pair is
        // complete so an idle-looking intermediate state cannot clear the
        // payload or re-enable the composer.
        return;
      }
      if (!runtimeWorking) {
        // Authoritative idle is not proof the turn finished: an agent can be
        // briefly idle between tool calls. Only settle once THIS turn's reply
        // is visible in the persisted history (an assistant message written
        // after the prompt was sent) — otherwise an early resync could drop
        // the late reply. Without a prompt baseline (defensive), never assume
        // a reply; the idle cap settles the monitor either way.
        const replyConfirmed = promptTimestamp !== undefined
          && await turnHasNewAssistantReply(client, sessionId, cwd, promptTimestamp);
        if (!replyConfirmed) {
          idleTicks += 1;
          if (idleTicks < idleLimitTicks) continue;
        }
        // Re-check before settling: the reply confirmation awaited a REST
        // round, during which the monitor may have been superseded or the
        // turn resumed working.
        const recheck = runtimeStore.getState();
        if (
          monitorGeneration !== generations.promptMonitor
          || (expectedActivityGeneration !== undefined && expectedActivityGeneration !== generations.activity)
          || recheck.activeSessionId !== sessionId
          || recheck.cwd !== cwd
          || !recheck.working
        ) return;
        ++generations.activity;
        runtimeStore.setState({ working: false, turnLifecycle: confirmedIdleLifecycle(recheck.thread, recheck.turnLifecycle), status: "ready", pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null });
        void resyncCompletedHistory(sessionId, cwd);
        void loadSessionsInternal();
        return;
      }
      idleTicks = 0;
    } catch {
      // Keep polling while the stream is still connecting. Transport failure
      // handling remains responsible for the visible connection status.
    }
  }
}

/** True when the persisted conversation already contains an assistant message
 *  written after the prompt was sent — i.e. this turn produced a reply that a
 *  history resync will find. The scan starts from the newest message; an
 *  assistant message without a parseable timestamp cannot be attributed to
 *  this turn and counts as unconfirmed.
 *
 *  Commentary is not an answer. An agent narrates between tool calls and can
 *  fall briefly idle, so a newest explicitly intermediate message must never
 *  confirm the reply: settling on it would drop the final answer that arrives
 *  afterwards. Only that explicit negative guard exists — final messages and
 *  legacy unclassified messages keep the timestamp rule, because a legacy
 *  runtime never classified its messages. */
async function turnHasNewAssistantReply(
  client: PiScienceClient,
  sessionId: string,
  cwd: string,
  promptTimestamp: number,
): Promise<boolean> {
  try {
    const page = await client.getMessagesPage(sessionId, cwd);
    const messages = page.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role !== "assistant") continue;
      if (messages[i].presentationRole === "intermediate") return false;
      const timestamp = messages[i].timestamp;
      if (!timestamp) return false;
      const parsed = Date.parse(timestamp);
      if (Number.isNaN(parsed)) return false;
      return parsed > promptTimestamp;
    }
    return false;
  } catch {
    return false;
  }
}
