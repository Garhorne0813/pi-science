/** Model changes and interaction responses preserve their request ownership fences. */
import { resolveInteraction } from "../interaction-queue";
import { activityPolicy } from "../../conversation/activity-policy";
import { clearCachedMessages, getClient, moveSessionName } from "../../client/pi-science-client";
import { appendRuntimeError } from "../errors";
import { resetTurnBuffer } from "../folding/state";
import { generations, turnState } from "../generations";
import { registerEventListener } from "../listening/subscription";
import { ensureTurnWatchdog } from "../listening/watchdog";
import type { RuntimeState } from "../types";
import type { GetState, SetState } from "./types";
import { interactionResponseKey } from "./identity";

const _interactionResponsePromises = new Map<string, Promise<void>>();
export function createCommandActions(set: SetState, get: GetState): Pick<RuntimeState, "setModel" | "respondToInteraction"> {

  return {
    setModel: async (model: string, thinking?: string) => {
      const { activeSessionId, cwd, working } = get();
      if (!activeSessionId) return null;
      if (working) throw new Error("Stop the current task before changing models");
      const activityGeneration = ++generations.activity;
      ++generations.localMutation;
      const client = getClient();
      registerEventListener(client);
      try {
        const result = await client.setModel(activeSessionId, model, cwd, thinking);
        const nextSessionId = result.id || activeSessionId;
        const current = get();
        if (
          activityGeneration === generations.activity
          && current.activeSessionId === activeSessionId
          && current.cwd === cwd
        ) {
          if (nextSessionId !== activeSessionId) {
            ++generations.connection;
            ++generations.activity;
            ++generations.localMutation;
            resetTurnBuffer();
            turnState.errored = false;
            clearCachedMessages(cwd, activeSessionId);
            client.clearCursor(cwd, activeSessionId);
            const movedName = moveSessionName(cwd, activeSessionId, nextSessionId);
              client.connect(nextSessionId, cwd);
            set({
              client,
              activeSessionId: nextSessionId, mcpDiagnostics: [],
              historyCursor: null,
              historyHasMore: false,
              historyLoading: false,
              historySnapshotVersion: "",
              model: result.model ?? model,
              thinking: result.thinking ?? thinking ?? current.thinking,
              status: result.restarted ? "connecting" : "ready",
              sessions: [
                {
                  ...(current.sessions.find((session) => session.id === activeSessionId) || { cwd }),
                  id: nextSessionId,
                  name: movedName || current.sessions.find((session) => session.id === activeSessionId)?.name,
                },
                ...current.sessions.filter((session) => session.id !== activeSessionId && session.id !== nextSessionId),
              ].slice(0, 50),
            });
            return nextSessionId;
          }
          set({
            client,
            activeSessionId: nextSessionId, mcpDiagnostics: [],
            sessions: nextSessionId === activeSessionId
              ? current.sessions
              : [
                  {
                    ...(current.sessions.find((session) => session.id === activeSessionId) || { cwd }),
                    id: nextSessionId,
                    name: current.sessions.find((session) => session.id === activeSessionId)?.name,
                  },
                  ...current.sessions.filter((session) => session.id !== activeSessionId && session.id !== nextSessionId),
                ].slice(0, 50),
            model: result.model ?? model,
            thinking: result.thinking ?? thinking ?? current.thinking,
            status: result.restarted ? "connecting" : "ready",
          });
        }
        return nextSessionId;
      } catch (error) {
        try {
          const runtimeState = await client.getSessionState(activeSessionId, cwd);
          const current = get();
          if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
            set({
              model: runtimeState.model ?? current.model,
              thinking: runtimeState.thinking ?? current.thinking,
              working: runtimeState.is_streaming || runtimeState.is_compacting,
            });
          }
        } catch {
          // Preserve the previous UI state when even the recovery read fails.
        }
        throw error;
      }
    },
    respondToInteraction: (response: { value?: string; confirmed?: boolean; cancelled?: boolean; alwaysAllow?: boolean }) => {
      const { activeSessionId, cwd, pendingInteraction } = get();
      if (!activeSessionId || !pendingInteraction) return Promise.resolve();
      const requestId = pendingInteraction.requestId;
      const key = interactionResponseKey(cwd, activeSessionId, requestId);
      const existing = _interactionResponsePromises.get(key);
      if (existing) return existing;
      const operation = (async () => {
        ++generations.activity;
        ++generations.localMutation;
        try {
          const result = await getClient().respondToInteraction(
            activeSessionId,
            requestId,
            response,
            cwd,
          );
          const current = get();
          if (
            current.activeSessionId === activeSessionId
            && current.cwd === cwd
            && current.pendingInteraction?.requestId === requestId
          ) {
            const resolvedBlocks = current.thread.blocks.map((block) => {
              if (block.kind !== "tool" || activityPolicy(block).plane !== "interaction") return block;
              // Resolve only the block this request is tied to. Without a
              // toolCallId the requestId itself is the only trustworthy link;
              // batch-resolving every interaction block would retire prompts the
              // user has not answered.
              const matches = pendingInteraction.toolCallId
                ? block.callId === pendingInteraction.toolCallId
                : block.callId === requestId;
              return matches ? { ...block, interactionResolved: true } : block;
            });
            const thread = resolvedBlocks.some((block, index) => block !== current.thread.blocks[index])
              ? { ...current.thread, blocks: resolvedBlocks, index: Object.fromEntries(resolvedBlocks.map((block, index) => [block.id, index])) }
              : current.thread;
            const remaining = resolveInteraction(current, requestId);
            set({ ...remaining, working: true, turnLifecycle: remaining.pendingInteraction ? "waiting" : "active", status: "ready", thread });
            ensureTurnWatchdog();
          }
          if (result?.warning) {
            appendRuntimeError(new Error(result.warning), activeSessionId, cwd);
          }
        } catch (error) {
          // A lost HTTP response can hide a completed save. Never imply that
          // Deny/retry rolls back permanent access when the outcome is unknown.
          const failure = response.alwaysAllow
            ? new Error(`${error instanceof Error ? error.message : "Approval failed"}. Always allow could not be confirmed; check MCP settings before retrying or denying this request.`)
            : error;
          const current = get();
          if (current.activeSessionId === activeSessionId && current.cwd === cwd) {
            appendRuntimeError(failure, activeSessionId, cwd);
            set({ status: "error" });
          }
          throw failure;
        }
      })();
      _interactionResponsePromises.set(key, operation);
      return operation.finally(() => {
        if (_interactionResponsePromises.get(key) === operation) _interactionResponsePromises.delete(key);
      });
    },
  };
}
