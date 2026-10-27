/** Create, fork, list and delete sessions while preserving workspace ownership. */
import type { ThreadBlock } from "../../../types/thread";
import { getClient, type HistoryMessage, type SessionInfo } from "../../client/pi-science-client";
import { appendRuntimeError } from "../errors";
import { attachTurnArtifacts } from "../folding/artifacts";
import { emptyThread, resetTurnBuffer } from "../folding/state";
import { threadFromMessages } from "../folding/history-conversion";
import { fetchPersistedTurnArtifacts } from "../turn-artifacts";
import { generations, turnState } from "../generations";
import { registerEventListener } from "../listening/subscription";
import { recoverMissingSession } from "../recovery/missing-session";
import { loadMoreSessionsInternal, loadSessionsInternal, optimisticSessionIds } from "../sessions";
import type { RuntimeState } from "../types";
import type { GetState, SetState } from "./types";

/** In-flight createSession calls per workspace, so concurrent first prompts
 *  (or a StrictMode double effect) share one backend session instead of
 *  racing two. Owned by `createNewSession`, which also clears each entry. */
const _createSessionPromises = new Map<string, Promise<string>>();
export function createSessionActions(set: SetState, get: GetState): Pick<RuntimeState, "loadSessions" | "loadMoreSessions" | "loadSession" | "forkSession" | "createNewSession" | "deleteSession" | "removeSession" | "setDraft"> {

  return {
    loadSessions: async (cwd?: string) => {
      return loadSessionsInternal(cwd);
    },
    loadMoreSessions: async () => loadMoreSessionsInternal(),
    loadSession: async (sessionId: string) => {
      const cwd = get().cwd;
      await get().connect(cwd, sessionId);
    },
    forkSession: async (sessionId: string) => {
      const { cwd } = get();
      const client = getClient();
      const result = await client.forkSession(sessionId, cwd);
      if (get().cwd !== cwd) {
        throw new Error("Workspace changed while the conversation was being forked");
      }
      ++generations.connection;
      ++generations.activity;
      ++generations.localMutation;
      optimisticSessionIds.add(result.id);
      set({ activeSessionId: result.id, mcpDiagnostics: [], status: "connecting", pendingInteraction: null, pendingInteractionQueue: [], pendingQuestionnaire: null });
      registerEventListener(client);
      client.connect(result.id, cwd);
      let history = {
        messages: [] as HistoryMessage[],
        next_cursor: null as string | null,
        has_more: false,
        snapshot_version: "",
      };
      let historyError: unknown = null;
      let artifactTurns = [] as Awaited<ReturnType<typeof fetchPersistedTurnArtifacts>>;
      const [historyResult, artifactsResult] = await Promise.allSettled([
        client.getMessagesPage(result.id, cwd),
        fetchPersistedTurnArtifacts(result.id, cwd),
      ]);
      if (historyResult.status === "fulfilled") history = historyResult.value;
      else historyError = historyResult.reason;
      if (artifactsResult.status === "fulfilled") artifactTurns = artifactsResult.value;
      const latest = get();
      if (latest.cwd !== cwd || latest.activeSessionId !== result.id) return result.id;
      set({
        client,
        activeSessionId: result.id, mcpDiagnostics: [],
        thread: attachTurnArtifacts(threadFromMessages(history.messages), artifactTurns, { windowComplete: !history.has_more }),
        historyCursor: history.next_cursor,
        historyHasMore: history.has_more,
        historyLoading: false,
        historySnapshotVersion: history.snapshot_version,
        working: false,
        turnLifecycle: "settled",
        sessions: [
          { id: result.id, cwd, project_id: get().sessions.find((session) => session.cwd === cwd)?.project_id ?? null, name: "New Session" },
          ...get().sessions.filter((session) => session.id !== result.id),
        ].slice(0, 50),
      });
      if (historyError) appendRuntimeError(historyError, result.id, cwd);
      await loadSessionsInternal();
      return result.id;
    },
    createNewSession: async () => {
      const requestCwd = get().cwd;
      const requestSessionId = get().activeSessionId;
      const requestGeneration = generations.connection;
      const requestKey = `${requestCwd}\0${requestGeneration}`;
      const existing = _createSessionPromises.get(requestKey);
      if (existing) return existing;
      const promise = (async () => {
        const client = getClient();
        const draft = get().draftModelSelection;
        const selection = draft?.cwd === requestCwd ? draft.selection : undefined;
        const approvalDraft = get().draftApproval;
        const initialApproval = !requestSessionId && approvalDraft?.cwd === requestCwd ? approvalDraft.approval : undefined;
        const result = initialApproval
          ? await client.createSession(requestCwd, selection?.model ?? undefined, selection?.thinking ?? undefined, initialApproval)
          : selection?.model ? await client.createSession(requestCwd, selection.model, selection.thinking) : await client.createSession(requestCwd);
        if (get().cwd !== requestCwd || generations.connection !== requestGeneration) {
          // A late blank runtime must neither replace a newer conversation nor leak capacity.
          // Deleting it is only safe while nobody has opened it: the server lists a session as
          // soon as it exists, so this one can already be the conversation on screen.
          const current = get();
          const inUse = current.activeSessionId === result.id || current.sessions.some((session) => session.id === result.id);
          if (!inUse) void client.deleteSession(result.id, requestCwd).catch(() => undefined);
          throw new Error(get().cwd !== requestCwd
            ? "Workspace changed while the conversation was being created"
            : "Conversation changed while the conversation was being created");
        }
        ++generations.connection;
        ++generations.activity;
        ++generations.localMutation;
        resetTurnBuffer();
        turnState.errored = false;
        registerEventListener(client);
        const live = get();
        set({
          client,
          activeSessionId: result.id, mcpDiagnostics: [],
          draftApproval: initialApproval && get().draftApproval === approvalDraft ? null : get().draftApproval,
          draftModelSelection: selection && get().draftModelSelection === draft ? null : get().draftModelSelection,
          thread: live.thread.blocks.length > 0 ? live.thread : emptyThread(),
          historyCursor: null,
          historyHasMore: false,
          historyLoading: false,
          historySnapshotVersion: "",
          // sendPrompt creates this session lazily while its prompt is already
          // in flight, so keep the live turn state. Resetting to settled here
          // renders the running turn as "Completed" for the whole
          // session-creation round trip, until sendPrompt re-arms it.
          working: live.working,
          turnLifecycle: live.turnLifecycle,
          status: "connecting",
          pendingInteraction: null,
          pendingInteractionQueue: [],
          pendingQuestionnaire: null,
        });
        optimisticSessionIds.add(result.id);
        client.connect(result.id, requestCwd);
        const newSession: SessionInfo = { id: result.id, cwd: requestCwd, project_id: result.project_id ?? null, name: "New Session" };
        set((s) => ({
          sessions: [
            newSession,
            ...s.sessions.filter((item) => item.id !== result.id),
          ].slice(0, 50),
        }));
        return result.id;
      })();
      _createSessionPromises.set(requestKey, promise);

      try {
        return await promise;
      } catch (error) {
        const current = get();
        const errorBlock: ThreadBlock = {
          kind: "status-line",
          id: `error-${Date.now()}`,
          text: error instanceof Error ? error.message : "Unable to create a new session",
          level: "error",
        };
        const nextBlocks = [...current.thread.blocks, errorBlock];
        if (current.cwd === requestCwd && current.activeSessionId === requestSessionId && generations.connection === requestGeneration) {
          set({
            thread: {
              blocks: nextBlocks,
              index: { ...current.thread.index, [errorBlock.id]: nextBlocks.length - 1 },
              loaded: true,
            },
            status: "error",
            working: false,
            turnLifecycle: "failed",
          });
        }
        throw error;
      } finally {
        if (_createSessionPromises.get(requestKey) === promise) {
          _createSessionPromises.delete(requestKey);
        }
      }
    },
    deleteSession: async (sessionId: string) => {
      const { cwd, activeSessionId } = get();
      await getClient().deleteSession(sessionId, cwd);
      if (activeSessionId === sessionId) {
        // Deleting the active conversation must clear its cursor/history/thread
        // state, not just drop the list row — reuse the full recovery reset.
        // Pass the client so the reset also disconnects any live SSE stream for
        // the deleted session (missing client leaves a phantom error state).
        recoverMissingSession(sessionId, cwd, getClient());
      } else {
        optimisticSessionIds.delete(sessionId);
        set((state) => ({ sessions: state.sessions.filter((session) => session.id !== sessionId) }));
      }
      await loadSessionsInternal();
    },
    removeSession: (sessionId: string) => {
      optimisticSessionIds.delete(sessionId);
      set((state) => ({ sessions: state.sessions.filter((session) => session.id !== sessionId) }));
    },
    setDraft: (text: string) => set({ draft: text }),
  };
}
