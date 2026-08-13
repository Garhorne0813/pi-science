import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode, Ref } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bookmark, Loader2, Square, Plus, Sparkles, X, File, FolderOpen } from "lucide-react";
import type { VirtuosoHandle, VirtuosoProps } from "react-virtuoso";
import { getClient, getSessionName } from "../../lib/client/pi-science-client";
import { queryClient } from "../../lib/client/query-client";
import { useRuntimeStore } from "../../lib/agent-runtime";
import type { PendingInteraction } from "../../lib/agent-runtime";
import { useUiStore } from "../../lib/ui";
import { cn } from "../../lib/ui";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";
import { projectKnowledgeApi, useReviewPolicy } from "../../lib/knowledge";
import { agentActionTextByBlock, fetchDynamicCommands, resetDynamicCommands } from "../../lib/conversation";
import { SlashCommandMenu } from "../../components/SlashCommandMenu";
import { ConversationWelcome } from "../../components/conversation/ConversationWelcome";
import { ModelControlMenu } from "../../components/conversation/ModelControlMenu";
import { InteractionPrompt } from "../../components/conversation/InteractionPrompt";
import { MentionComposer } from "../../components/conversation/MentionComposer";
import { QuestionnairePrompt } from "../../components/conversation/QuestionnairePrompt";
import { groupBlocks, renderBlockGroup } from "../../components/conversation/ConversationBlocks";
import { ConversationNavRail, type ConversationNavItem } from "../../components/conversation/ConversationNavRail";
import { ConversationBookmarksPanel } from "../../components/conversation/ConversationBookmarksPanel";
import type { MessageBookmarkAction } from "../../components/conversation/MessageActions";
import { useConversationNavigation } from "../../hooks/useConversationNavigation";
import type { ConversationBookmark } from "../../lib/conversation-navigation";
import { visibleUserMessage } from "../../lib/files";
import { useTranslation } from "react-i18next";
import { ResearchLoopDraftCard, ResearchLoopStatusCard, ResearchModePicker } from "../../components/conversation/ResearchLoopControls";
import { useTurnEffects } from "../../hooks/useTurnEffects";
import { useModelConfig } from "../../hooks/useModelConfig";
import { useResearchLoop } from "../../hooks/useResearchLoop";
import { useComposer } from "../../hooks/useComposer";
import type { ThreadBlock } from "../../types/thread";

type ConversationVirtuosoContext = {
  renderInteractionPrompt: () => ReactNode;
  working: boolean;
  pendingInteraction: PendingInteraction | null;
};
type ConversationVirtuosoProps = VirtuosoProps<ThreadBlock[], ConversationVirtuosoContext> & { ref?: Ref<VirtuosoHandle> };
const LazyVirtuoso = lazy(() => import("react-virtuoso").then(({ Virtuoso }) => ({
  default: Virtuoso as unknown as ComponentType<ConversationVirtuosoProps>,
})));
const ComposerTodo = lazy(() => import("../../components/todo/ComposerTodo").then((m) => ({ default: m.ComposerTodo })));

/** Reading-position restore retry interval and budget. The store refuses
 *  history loads while the newest page is still loading (a cold Pi runtime
 *  spawn can keep it busy for seconds), and the restored page then needs
 *  several more seconds to render its anchor through the virtual list, so the
 *  restore retries within this window instead of giving up early. The safety
 *  net still bounds the worst case, and any user navigation (nav select,
 *  bookmark jump, send, back-to-latest) cancels the restore immediately. */
const RESTORE_RETRY_MS = 250;
const RESTORE_BUDGET_MS = 30_000;
/** Suppression grace after the anchor scroll: viewport-driven read-state
 *  writes stay paused through the scroll-correction window so the restored
 *  position cannot be overwritten by a premature bottom-seen write. */
const RESTORE_SETTLE_MS = 400;
/** Scroll events arriving within this window after a programmatic scroll
 *  (entry bottom snap, working-turn snap) are treated as part of that
 *  programmatic scroll: they must not count as manual user interaction and
 *  cancel a pending reading-position restore. Real browsers deliver the
 *  scroll event a frame or two after the programmatic scroll, so the window
 *  is a few frames wide. */
const PROGRAMMATIC_SCROLL_WINDOW_MS = 400;

/**
 * Keep the virtual-list footer component type stable. Defining Footer inline
 * inside LiveSessionPage would give Virtuoso a new component type whenever a
 * scroll update re-renders the page, unmounting the questionnaire and losing
 * its local answer state.
 */
export function ConversationFooter() {
  const pendingInteraction = useRuntimeStore((s) => s.pendingInteraction);
  const pendingQuestionnaire = useRuntimeStore((s) => s.pendingQuestionnaire);
  const working = useRuntimeStore((s) => s.working);
  const respondToInteraction = useRuntimeStore((s) => s.respondToInteraction);

  return (
    <div className="mx-auto flex w-full max-w-[824px] flex-col gap-4 px-8 pb-6 pt-2">
      {pendingQuestionnaire && pendingInteraction?.questionnaire ? (
        <QuestionnairePrompt
          questionnaire={pendingQuestionnaire}
          interaction={pendingInteraction}
          onRespond={(response) => void respondToInteraction(response).catch(() => undefined)}
        />
      ) : pendingInteraction ? (
        <InteractionPrompt
          interaction={pendingInteraction}
          onRespond={(response) => void respondToInteraction(response).catch(() => undefined)}
        />
      ) : null}
      {working && !pendingInteraction && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Loader2 size={14} className="animate-spin text-accent" />
          Working…
        </div>
      )}
    </div>
  );
}

export function LiveSessionPage() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const navigate = useNavigate();
  // Field-level selectors, not a whole-store subscription: a streamed token only
  // touches `thread`/`working`, so nothing that reads the other fields re-renders.
  const status = useRuntimeStore((s) => s.status);
  const rawThread = useRuntimeStore((s) => s.thread);
  // Defensive: transient store states (mid-recovery / mid-delete) must never
  // crash rendering with "blocks is not iterable" — normalize to a safe shape.
  const thread = Array.isArray(rawThread?.blocks)
    ? rawThread
    : { blocks: [] as ThreadBlock[], index: {} as Record<string, number>, loaded: true };
  const sessions = useRuntimeStore((s) => s.sessions);
  const working = useRuntimeStore((s) => s.working);
  const historyHasMore = useRuntimeStore((s) => s.historyHasMore);
  const historyLoading = useRuntimeStore((s) => s.historyLoading);
  const loadOlderMessages = useRuntimeStore((s) => s.loadOlderMessages);
  const loadMessagesForNavigation = useRuntimeStore((s) => s.loadMessagesForNavigation);
  const connect = useRuntimeStore((s) => s.connect);
  const disconnect = useRuntimeStore((s) => s.disconnect);
  const abort = useRuntimeStore((s) => s.abort);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const contextTokens = useRuntimeStore((s) => s.contextTokens);
  const contextWindow = useRuntimeStore((s) => s.contextWindow);
  const contextPercent = useRuntimeStore((s) => s.contextPercent);
  const compactionEnabled = useRuntimeStore((s) => s.compactionEnabled);
  const compactionThresholdPercent = useRuntimeStore((s) => s.compactionThresholdPercent);
  const pendingInteraction = useRuntimeStore((s) => s.pendingInteraction);
  const pendingQuestionnaire = useRuntimeStore((s) => s.pendingQuestionnaire);
  const respondToInteraction = useRuntimeStore((s) => s.respondToInteraction);
  const interactionPending = Boolean(pendingInteraction || pendingQuestionnaire);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const followOutputRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [virtualFirstItemIndex, setVirtualFirstItemIndex] = useState(100_000);
  // Scroll-correction timers (nav targeting / post-send snap) are tracked so a
  // newer interaction or an unmount cancels stale callbacks before they touch
  // the next session's page. sessionRef guards against cross-session staleness.
  const scrollTimersRef = useRef<number[]>([]);
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    return () => {
      for (const handle of scrollTimersRef.current) window.clearTimeout(handle);
      scrollTimersRef.current = [];
      if (programmaticScrollTimerRef.current !== null) window.clearTimeout(programmaticScrollTimerRef.current);
    };
  }, []);

  // A new session (or a reconnect) starts at the bottom: never inherit the
  // "user scrolled up" state of the previous session on this route.
  useEffect(() => {
    followOutputRef.current = true;
    setShowScrollDown(false);
    setVirtualFirstItemIndex(100_000);
  }, [sessionId, workspaceCwd]);
  const [reviewingProject, setReviewingProject] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const removeWorkspaceReference = useUiStore((state) => state.removeWorkspaceReference);

  const messageIndexQuery = useQuery({
    queryKey: ["session-message-index", workspaceCwd, sessionId ?? null],
    queryFn: () => getClient().getMessageIndex(sessionId!, workspaceCwd, "all"),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  }, queryClient);

  // ── Durable navigation: bookmarks, read position, attention ──
  const { readState, readStateLoading, bookmarks, bookmarksLoading, createBookmark, acceptBookmark, rejectBookmark, deleteBookmark, proposeBookmarks, proposePending, proposeResult, proposeError, scheduleAnchorWrite, scheduleMarkSeen, cancelPendingWrites } = useConversationNavigation(workspaceCwd, sessionId);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const bookmarksTriggerRef = useRef<HTMLButtonElement>(null);
  const bookmarksPanelId = "conversation-bookmarks-panel";
  const closeBookmarks = useCallback(() => {
    setBookmarksOpen(false);
    bookmarksTriggerRef.current?.focus();
  }, []);
  // Rejected bookmarks stay on the server record but are never displayed or
  // counted in the UI: they only exist so a later user action can revive them.
  const sessionBookmarks = useMemo(
    () => bookmarks.filter((bookmark) => bookmark.session_id === sessionId && bookmark.status !== "rejected"),
    [bookmarks, sessionId],
  );
  // The header badge counts ACCEPTED bookmarks only — proposals are pending
  // review and must not inflate the number shown on the trigger.
  const headerBookmarkCount = sessionBookmarks.filter((bookmark) => bookmark.status === "accepted").length;
  // While a restore is being decided / executed, viewport-driven read-state
  // writes are suppressed so a stale cursor cannot overwrite the saved one.
  const suppressReadWriteRef = useRef(true);
  const restoreSessionRef = useRef<string | null>(null);
  const wasWorkingNav = useRef(false);
  // Persistent user-interaction cancellation marker for the reading-position
  // restore: once the user has manually scrolled, changed the active anchor
  // or explicitly navigated while the read state was still loading, a late
  // read-state response must NOT start a restore (or yank the viewport to
  // the saved position). Reset only on a session/workspace change.
  const userNavInterruptedRef = useRef(false);
  // True while a programmatic scroll (entry bottom snap, working-turn snap)
  // is in flight, so its scroll events are not mistaken for manual user
  // interaction. Programmatic restore scrolls must not self-cancel.
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  // The rail's first active report is its mount-time baseline (the first
  // entry its observer geometry establishes — nothing is active before
  // that), not a user position change; it must not cancel a pending
  // restore. Any later active-anchor change is a user position signal.
  const railReportedRef = useRef(false);
  // The user-intent listeners (declared before cancelRestore) cancel an
  // already-running restore through this ref, so their declaration order
  // stays independent of cancelRestore's. Kept in sync right after the
  // cancelRestore callback below.
  const cancelRestoreRef = useRef<() => void>(() => undefined);

  // Session-scoped reset as a LAYOUT effect: React flushes child passive
  // effects before parent passive effects in the same commit, and the
  // Suspense-delayed first commit mounts the nav rail (whose mount report
  // reaches handleActiveChange) before a passive reset would run — the
  // rail's first report must never be mistaken for a user position change.
  // Layout effects always flush before any passive effect, so the reset is
  // guaranteed to land before the rail's mount report.
  useLayoutEffect(() => {
    // New session: cancel stale writes and suppress read-state writes until
    // the restore decision has been made. The user-interaction marker is
    // session-scoped: a fresh entry may restore its saved position again.
    suppressReadWriteRef.current = true;
    restoreSessionRef.current = null;
    userNavInterruptedRef.current = false;
    railReportedRef.current = false;
    programmaticScrollRef.current = false;
    cancelPendingWrites();
  }, [sessionId, workspaceCwd, cancelPendingWrites]);

  // Read-state loading safety timeout: if the query never settles (network
  // hang / server down), stop waiting and release viewport-driven writes so
  // navigation is not blocked indefinitely. The restore is deliberately NOT
  // marked done here: a read state that arrives late must still restore the
  // saved position instead of being silently discarded (the restore effect
  // re-asserts suppression when it runs, so the released window is bounded).
  const readStateLoadingRef = useRef(readStateLoading);
  useEffect(() => { readStateLoadingRef.current = readStateLoading; }, [readStateLoading]);
  useEffect(() => {
    if (!sessionId) return;
    const handle = window.setTimeout(() => {
      if (sessionRef.current !== sessionId) return;
      if (restoreSessionRef.current !== sessionId && readStateLoadingRef.current) {
        suppressReadWriteRef.current = false;
      }
    }, 8000);
    return () => window.clearTimeout(handle);
  }, [sessionId]);

  // A completed turn invalidates the all-role index and the attention queue so
  // new bookmarks and sidebar badges appear without a manual refresh.
  useEffect(() => {
    if (wasWorkingNav.current && !working) {
      void queryClient.invalidateQueries({ queryKey: ["session-message-index", workspaceCwd, sessionId ?? null] });
      void queryClient.invalidateQueries({ queryKey: ["conversation-navigation", "attention", workspaceCwd] });
    }
    wasWorkingNav.current = working;
  }, [working, workspaceCwd, sessionId]);

  // Optimistic user blocks (id `user-<timestamp>`) are created locally on
  // send and never match the server index directly. Reconcile them to their
  // persisted entry by exact visible text (consuming persisted entries in
  // order) so nav dedup, bookmark actions and jumps use the durable id — the
  // canonical transcript is not rewritten.
  const optimisticUserMatch = useMemo(() => {
    const match = new Map<string, string>();
    const persistedByText = new Map<string, string[]>();
    for (const entry of messageIndexQuery.data?.messages ?? []) {
      if (entry.role !== "user" || !entry.text) continue;
      const ids = persistedByText.get(entry.text) ?? [];
      ids.push(entry.id);
      persistedByText.set(entry.text, ids);
    }
    const used = new Set<string>();
    for (const block of thread.blocks) {
      if (block.kind !== "user" || !block.text) continue;
      if (block.id.startsWith("user-") && persistedByText.has(block.text)) {
        for (const candidate of persistedByText.get(block.text)!) {
          if (used.has(candidate)) continue;
          used.add(candidate);
          match.set(block.id, candidate);
          break;
        }
      }
    }
    return match;
  }, [messageIndexQuery.data?.messages, thread.blocks]);

  // Bookmark actions are only offered for messages the server all-role index
  // has confirmed as persisted — live temporary ids never qualify. Optimistic
  // user blocks resolve through `optimisticUserMatch` to their durable id.
  const bookmarkActions = useMemo(() => {
    const indexed = new Set((messageIndexQuery.data?.messages ?? []).map((entry) => entry.id));
    const byMessage = new Map<string, ConversationBookmark>();
    for (const bookmark of sessionBookmarks) {
      byMessage.set(bookmark.message_id, bookmark);
    }
    const actions = new Map<string, MessageBookmarkAction>();
    for (const block of thread.blocks) {
      if (block.kind !== "user" && block.kind !== "agent") continue;
      const persistedId = block.kind === "user"
        ? (indexed.has(block.id) ? block.id : optimisticUserMatch.get(block.id) ?? null)
        : (indexed.has(block.id) ? block.id : null);
      if (!persistedId) continue;
      const existing = byMessage.get(persistedId);
      const status: MessageBookmarkAction["status"] = existing?.status === "accepted" ? "accepted" : existing?.status === "proposed" ? "proposed" : "none";
      actions.set(block.id, {
        status,
        onToggle: () => {
          if (!existing) createBookmark(persistedId);
          else if (existing.status === "accepted") deleteBookmark(existing.bookmark_id);
          else acceptBookmark(existing.bookmark_id);
        },
      });
    }
    return actions;
  }, [sessionBookmarks, messageIndexQuery.data?.messages, thread.blocks, optimisticUserMatch, createBookmark, acceptBookmark, deleteBookmark]);

  useEffect(() => {
    connect(workspaceCwd, sessionId || undefined);
    const workspacePrefix = `/workspace/${encodeURIComponent(workspaceCwd)}`;
    return () => {
      // Keep the conversation stream alive while the user inspects files,
      // notebooks, runs, or project knowledge in the same workspace. A later
      // session connect will replace it, and leaving the workspace closes it.
      if (!window.location.pathname.startsWith(workspacePrefix)) disconnect();
    };
  }, [sessionId, workspaceCwd, connect, disconnect]);

  const handleThreadScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
    followOutputRef.current = nearBottom;
    setShowScrollDown(!nearBottom);
    // A scroll that is not part of a programmatic scroll (entry bottom snap,
    // working-turn snap) is manual user interaction: it marks the
    // reading-position restore as superseded, so a read state that is still
    // loading cannot later start a restore that yanks the viewport away.
    if (!programmaticScrollRef.current) userNavInterruptedRef.current = true;
    // Reaching the bottom marks the current snapshot as seen (deduplicated
    // server-side by snapshot version), which clears the sidebar New badge.
    if (nearBottom && !suppressReadWriteRef.current) {
      const snapshot = messageIndexQuery.data?.snapshot_version;
      if (snapshot && !(readState?.at_bottom === true && readState.seen_snapshot_version === snapshot)) {
        scheduleMarkSeen(snapshot);
      }
    }
  }, [messageIndexQuery.data?.snapshot_version, scheduleMarkSeen, readState]);

  // User-intent listeners on the scroller: wheel / touch / pointer input is
  // manual user interaction even when its scroll events land inside the
  // programmatic-scroll grace window (programmatic `.scrollTo` never emits
  // these events). Marking the session entry here closes the hole where a
  // user wheeled during the entry bottom-snap grace and a late read-state
  // response still started a restore that yanked the viewport away.
  const handleUserIntent = useCallback(() => {
    userNavInterruptedRef.current = true;
    // A wheel/touch/pointer input also supersedes an ALREADY-RUNNING restore
    // (retry timers + write suppression), not just a pending decision: the
    // user is actively reading history, so a late correction scroll must not
    // yank the viewport away.
    cancelRestoreRef.current();
  }, []);

  // Viewport reading position: the rail reports the active user message only
  // when it actually changes; near-bottom is handled by the mark-seen path.
  const handleActiveChange = useCallback((id: string | null) => {
    if (!id) return;
    // The rail's first report is its mount-time baseline (the newest user
    // message), not a user position change: it must not cancel a pending
    // restore. Any LATER active-anchor change before the restore decision is
    // a user signal that the saved reading position is stale.
    if (railReportedRef.current) {
      userNavInterruptedRef.current = true;
    } else {
      railReportedRef.current = true;
    }
    if (suppressReadWriteRef.current) return;
    const scroller = scrollRef.current;
    const nearBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96 : false;
    if (nearBottom) return;
    // Live optimistic user blocks carry temporary ids that the server refuses
    // as anchors; resolve them to the persisted id once the all-role index
    // knows it. While the message is still live-only, skip the write rather
    // than failing it against the server.
    const persistedId = optimisticUserMatch.get(id)
      ?? ((messageIndexQuery.data?.messages ?? []).some((entry) => entry.id === id) ? id : null);
    if (!persistedId) return;
    scheduleAnchorWrite(persistedId);
  }, [scheduleAnchorWrite, optimisticUserMatch, messageIndexQuery.data?.messages]);

  const bookmarkedUserIds = useMemo(() => new Set(
    bookmarks
      .filter((bookmark) => bookmark.session_id === sessionId && bookmark.status === "accepted" && bookmark.role === "user")
      .map((bookmark) => bookmark.message_id),
  ), [bookmarks, sessionId]);

  const attachScroller = useCallback((element: Window | HTMLElement | null) => {
    if (scrollRef.current) {
      scrollRef.current.removeEventListener("scroll", handleThreadScroll);
      scrollRef.current.removeEventListener("wheel", handleUserIntent);
      scrollRef.current.removeEventListener("touchstart", handleUserIntent);
      scrollRef.current.removeEventListener("pointerdown", handleUserIntent);
    }
    scrollRef.current = element instanceof HTMLElement ? element as HTMLDivElement : null;
    if (scrollRef.current) {
      // Keep the stable class hook used by the conversation rail and by
      // integrations that locate the active conversation scroller.
      scrollRef.current.classList.add("conversation-scroller", "overflow-y-auto");
      scrollRef.current.addEventListener("scroll", handleThreadScroll);
      // Session-scoped cleanup: the user-intent listeners are removed when
      // the scroller is replaced (above) and die with the element on
      // unmount, so they can never leak into the next session's page.
      scrollRef.current.addEventListener("wheel", handleUserIntent);
      scrollRef.current.addEventListener("touchstart", handleUserIntent);
      scrollRef.current.addEventListener("pointerdown", handleUserIntent);
    }
  }, [handleThreadScroll, handleUserIntent]);

  // Run a viewport scroll that must not count as manual user interaction
  // (entry bottom snap, working-turn snap): scroll events arriving within the
  // window are treated as programmatic, so they cannot cancel a pending
  // reading-position restore.
  const runProgrammaticScroll = useCallback((scroll: () => void) => {
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) window.clearTimeout(programmaticScrollTimerRef.current);
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, PROGRAMMATIC_SCROLL_WINDOW_MS);
    scroll();
  }, []);

  useLayoutEffect(() => {
    if (followOutputRef.current) {
      runProgrammaticScroll(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      });
    }
  }, [thread.blocks, runProgrammaticScroll]);

  // When a new turn starts (user sends a message or the agent resumes), snap
  // the view back to the newest content. The user may have scrolled up to read
  // history; sending a message — or receiving live output — must always bring
  // the latest message into view instead of leaving the thread pinned to the
  // old position.
  const wasWorking = useRef(false);
  useEffect(() => {
    if (working && !wasWorking.current) {
      // Only snap to the bottom on a NEW turn if the user is not deliberately
      // reading history (followOutputRef stays false after a nav click).
      if (followOutputRef.current === false) return;
      followOutputRef.current = true;
      setShowScrollDown(false);
      runProgrammaticScroll(() => {
        const scroller = scrollRef.current;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      });
    }
    wasWorking.current = working;
  }, [working, runProgrammaticScroll]);

  const blockGroups = useMemo(() => groupBlocks(thread.blocks), [thread.blocks]);
  // Copy-button eligibility computed across the WHOLE thread (not per group):
  // agentActionTextByBlock needs the trailing tool blocks after an agent block
  // to decide whether it is the final answer. A per-group computation would
  // give every agent block a copy button.
  const actionTextByBlock = useMemo(() => agentActionTextByBlock(thread.blocks), [thread.blocks]);

  const handleLoadOlder = async () => {
    if (!historyHasMore || historyLoading) return;
    const previousGroupCount = blockGroups.length;
    const loadedMessages = await loadOlderMessages();
    if (!loadedMessages) return;
    const nextGroupCount = groupBlocks(useRuntimeStore.getState().thread.blocks).length;
    const addedGroups = Math.max(0, nextGroupCount - previousGroupCount);
    if (addedGroups > 0) setVirtualFirstItemIndex((current) => current - addedGroups);
  };

  const { suggestions, setSuggestions } = useTurnEffects(working, thread.blocks);

  // Loaded-user-anchor signature for the nav rail: the all-role index knows
  // every user message id up front (paginated ones carry `before` cursors),
  // so the rail cannot tell from its items alone when an older page's anchors
  // mount. This key changes exactly when loaded user blocks change, letting
  // the rail re-register its observer for the newly attached DOM anchors
  // (history loads, reading-position restores, streamed user turns).
  const loadedUserAnchorKey = useMemo(
    () => thread.blocks.filter((block) => block.kind === "user").map((block) => block.id).join("\u0000"),
    [thread.blocks],
  );

  const userNavItems = useMemo<ConversationNavItem[]>(() => {
    const loadedUsers = thread.blocks.filter((block): block is Extract<ThreadBlock, { kind: "user" }> => block.kind === "user");
    const loadedById = new Map(loadedUsers.map((block) => [block.id, block]));
    // A persisted entry that is loaded under its own id OR matched to an
    // optimistic block is already on screen — no `before` cursor needed.
    const matchedPersistedIds = new Set(optimisticUserMatch.values());
    const seen = new Set<string>();
    const toItem = (id: string, text: string, before?: string): ConversationNavItem => {
      const visible = visibleUserMessage(text);
      return { id, label: (visible || t("conversation.attachment")).slice(0, 120), full: text, before };
    };
    const indexed = (messageIndexQuery.data?.messages ?? [])
      .filter((entry) => entry.role === "user")
      .map((entry) => {
        const loaded = loadedById.get(entry.id) ?? (matchedPersistedIds.has(entry.id) ? { text: entry.text } : undefined);
        seen.add(entry.id);
        return toItem(entry.id, loaded?.text ?? entry.text, loaded ? undefined : entry.before);
      });
    // Optimistic blocks matched to a persisted entry are represented by the
    // persisted item above; unmatched ones remain as live items.
    const live = loadedUsers
      .filter((block) => !seen.has(block.id) && !optimisticUserMatch.has(block.id))
      .map((block) => toItem(block.id, block.text));
    return [...indexed, ...live];
  }, [messageIndexQuery.data?.messages, t, thread.blocks, optimisticUserMatch]);

  const smoothScroll = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Runs fn after `delay` only while the page still shows the same session;
  // every pending handle is tracked so newer interactions/unmount can cancel.
  const scheduleSessionScoped = useCallback((fn: () => void, delay: number) => {
    const scheduledSession = sessionRef.current;
    const handle = window.setTimeout(() => {
      if (sessionRef.current !== scheduledSession) return;
      fn();
    }, delay);
    scrollTimersRef.current.push(handle);
  }, []);
  const cancelPendingScrollTimers = useCallback(() => {
    for (const handle of scrollTimersRef.current) window.clearTimeout(handle);
    scrollTimersRef.current = [];
  }, []);
  // The reading-position restore retry loop runs on session-scoped timers and
  // holds viewport-write suppression while it runs. A user action that
  // supersedes the restore (nav select, bookmark jump, send, back-to-latest)
  // must cancel those timers AND release the suppression, or the user's own
  // scroll/read-state writes stay blocked until the next session change. The
  // generation bump also invalidates any restore callback already in flight
  // (a promise continuation cannot be cancelled, so it must bail on its own).
  const restoreGenerationRef = useRef(0);
  const cancelRestore = useCallback(() => {
    restoreGenerationRef.current += 1;
    cancelPendingScrollTimers();
    suppressReadWriteRef.current = false;
  }, [cancelPendingScrollTimers]);
  // Keep the user-intent ref in sync: cancelRestore's identity is stable
  // (its only dep cancelPendingScrollTimers is stable), so a render-time
  // assignment is idempotent and always points at the latest callback.
  cancelRestoreRef.current = cancelRestore;
  // Explicit user navigation supersedes the reading-position restore: mark
  // the session entry persistently so a LATE read-state response (still
  // loading when the user acted) cannot start a restore, and cancel the
  // in-flight retry loop + write suppression.
  const supersedeRestore = useCallback(() => {
    userNavInterruptedRef.current = true;
    cancelRestore();
  }, [cancelRestore]);
  // Load the page containing a target with bounded retries. A 0 result can
  // mean the store's history load is already in flight (historyLoading) or the
  // session changed; retries absorb the transient case, and the session guard
  // drops stale callbacks so an old session's promise can never release the
  // current session's write suppression. `onSettled` always fires exactly once
  // for the current session (loaded count or 0 after retries are exhausted).
  const loadOlderForTarget = useCallback((before: string, onSettled: (loaded: number) => void, retries = 3) => {
    const scheduledSession = sessionRef.current;
    let attempts = 0;
    const attempt = (): void => {
      if (sessionRef.current !== scheduledSession) return;
      void loadMessagesForNavigation(before).then((loaded) => {
        if (sessionRef.current !== scheduledSession) return;
        if (loaded > 0) { onSettled(loaded); return; }
        if (attempts < retries) {
          attempts += 1;
          scheduleSessionScoped(attempt, 150);
          return;
        }
        onSettled(0);
      });
    };
    attempt();
  }, [loadMessagesForNavigation, scheduleSessionScoped]);
  const scrollToLoadedTarget = useCallback((id: string) => {
    const targetElement = () => document.getElementById(`user-msg-${id}`) ?? document.getElementById(`agent-msg-${id}`);
    const scrollToExact = () => {
      const target = targetElement();
      if (!target) return false;
      // Instant positioning (behavior "auto"): a smooth animation would race
      // the getBoundingClientRect offset check below.
      target.scrollIntoView({ behavior: "auto", block: "start" });
      return true;
    };
    // Fast path: the target is already mounted and Virtuoso's native layout
    // can honor a direct scroll (recent messages, short threads). Check the
    // result: if the target is not near the viewport top afterwards, fall
    // through to the Virtuoso scrollToIndex path (virtualized lists position
    // items absolutely, so a native scrollIntoView can land mid-list).
    const scrollerNow = scrollRef.current;
    const beforeTop = scrollerNow?.scrollTop ?? -1;
    if (scrollToExact() && scrollerNow) {
      const target = targetElement();
      if (target) {
        const r = target.getBoundingClientRect();
        const vr = scrollerNow.getBoundingClientRect();
        const offset = r.top - vr.top;
        if (offset >= -20 && offset < 300) return;
      }
      scrollerNow.scrollTop = beforeTop;
    }
    const groupIndex = groupBlocks(useRuntimeStore.getState().thread.blocks).findIndex((group) => group.some((block) => block.id === id));
    if (groupIndex >= 0) {
      // Virtuoso's scrollToIndex takes the 0-based data index (its data-index
      // attribute), NOT firstItemIndex + dataIndex — the latter overflows for
      // long conversations and clamps to the last item.
      virtuosoRef.current?.scrollToIndex({
        index: groupIndex,
        align: "start",
        behavior: "auto",
      });
      // After Virtuoso mounts the group, scroll again so the target lands at
      // the top of the viewport exactly (height estimation is inexact).
      scheduleSessionScoped(() => { if (!scrollToExact()) scheduleSessionScoped(scrollToExact, 250); }, 120);
      scheduleSessionScoped(scrollToExact, 350);
    } else {
      scrollToExact();
    }
  }, [scheduleSessionScoped]);
  const handleNavSelect = (id: string) => {
    // A new navigation supersedes the reading-position restore: cancel its
    // retry timers, invalidate in-flight callbacks, release the write
    // suppression it was holding, and mark the session entry so a late
    // read-state response cannot start a restore either.
    supersedeRestore();
    // Stop the follow-output effect from yanking the viewport back to the bottom.
    followOutputRef.current = false;
    const target = userNavItems.find((item) => item.id === id);
    if (target?.before) {
      loadOlderForTarget(target.before, (loaded) => {
        // Zero (after retries): the target may already be mounted — try a
        // direct scroll instead of silently doing nothing.
        if (loaded > 0) scheduleSessionScoped(() => scrollToLoadedTarget(id), 0);
        else scrollToLoadedTarget(id);
      });
      return;
    }
    scrollToLoadedTarget(id);
  };

  // Restore the persisted reading position once per session entry. Lives
  // after the scroll helpers so the restore can reuse them.
  useEffect(() => {
    if (!sessionId || readStateLoading || restoreSessionRef.current === sessionId) return;
    restoreSessionRef.current = sessionId;
    const restoreSession = sessionId;
    // The user interacted (manual scroll, active-anchor change, or explicit
    // navigation) while the read state was still loading: a late read-state
    // response must not start a restore or yank the viewport to the saved
    // position. The marker is persistent for the session entry, so a later
    // read-state refetch cannot retry the restore either. Restore done =
    // cancelled by the user's own position.
    if (userNavInterruptedRef.current) {
      suppressReadWriteRef.current = false;
      return;
    }
    const generation = ++restoreGenerationRef.current;
    const releaseWrites = () => {
      // Session guard: a stale callback from a previous session must never
      // release the current session's write suppression.
      if (sessionRef.current !== restoreSession) return;
      suppressReadWriteRef.current = false;
    };
    // Stale when the session changed or a user action superseded the restore
    // (cancelRestore bumps the generation). In-flight promise continuations
    // that cannot be cancelled check this before scheduling anything.
    const stale = () => sessionRef.current !== restoreSession || restoreGenerationRef.current !== generation;
    if (!readState) {
      // No read state (or the endpoint is unavailable): nothing to restore,
      // viewport-driven writes are safe.
      releaseWrites();
      return;
    }
    if (readState.at_bottom) {
      // Already at the newest content: keep the default bottom behavior.
      releaseWrites();
      return;
    }
    if (!readState.anchor_available || !readState.before || !readState.anchor_message_id) {
      // Anchor missing or stale (compaction/rewrite, non-indexed message):
      // fall back to the bottom.
      releaseWrites();
      return;
    }
    const anchorId = readState.anchor_message_id;
    // The anchor is the ground truth for the restore: mounted means the page
    // containing it has landed AND Virtuoso renders it in the viewport range.
    const anchorMounted = () => Boolean(
      document.getElementById(`user-msg-${anchorId}`) || document.getElementById(`agent-msg-${anchorId}`),
    );
    // The anchor counts as reachable once it is in the loaded thread: the
    // scroller may still have it virtualized out of the DOM, but
    // scrollToLoadedTarget mounts it through Virtuoso's scrollToIndex path.
    const anchorInThread = () => {
      const threadState = useRuntimeStore.getState().thread;
      return Boolean(threadState?.index && threadState.index[anchorId] !== undefined);
    };
    // The user asked to resume a saved position: stop following output so
    // live block changes (streaming, a delayed history page landing after the
    // restore) cannot snap the viewport back to the newest content.
    followOutputRef.current = false;
    // Re-assert write suppression: the 8s read-state safety timeout may have
    // released it while this session's read state was still in flight. The
    // restore must not race a viewport-driven write during its scroll.
    suppressReadWriteRef.current = true;
    const settleAndScroll = () => {
      // Re-assert on every settle pass: the initial bottom-snap scroll event
      // can re-enable follow-output while the restore is still correcting, and
      // a follow-output true would snap the viewport back to newest content
      // the next time a block lands (virtualizing the anchor away).
      followOutputRef.current = false;
      scheduleSessionScoped(() => {
        if (stale()) return;
        scrollToLoadedTarget(anchorId);
      }, 0);
    };
    // The initial connect/resync compose the thread asynchronously and can
    // reorder or drop the anchor page while the restore is running, so a
    // single load+scroll is not enough. Re-assert until the anchor actually
    // mounts: each pass loads the page when missing (prepend dedups by id, so
    // repeats are harmless), scrolls to the anchor's current position, and
    // once all composition settles the anchor page lands where it belongs.
    const deadline = Date.now() + RESTORE_BUDGET_MS;
    const attempt = (): void => {
      if (stale()) return;
      // Re-assert on every retry pass (see settleAndScroll): the saved
      // position is the user's place, so no pass may leave follow-output on.
      followOutputRef.current = false;
      if (anchorMounted()) {
        settleAndScroll();
        // Keep viewport-driven writes suppressed through the scroll-correction
        // window so the anchor jump cannot be overwritten by a premature
        // bottom-seen write, then release them.
        scheduleSessionScoped(releaseWrites, RESTORE_SETTLE_MS);
        return;
      }
      if (Date.now() >= deadline) {
        // Budget exhausted: if the anchor is in the thread, one final scroll
        // attempt; otherwise the bottom is the graceful fallback. Never leave
        // writes suppressed or follow-output off after giving up.
        if (anchorInThread()) {
          settleAndScroll();
          scheduleSessionScoped(releaseWrites, RESTORE_SETTLE_MS);
          return;
        }
        followOutputRef.current = true;
        releaseWrites();
        return;
      }
      if (anchorInThread()) {
        // The page is already loaded (warm cache / same-session entry): keep
        // scrolling to its (possibly moved) position until it mounts.
        settleAndScroll();
        scheduleSessionScoped(attempt, RESTORE_RETRY_MS);
        return;
      }
      // The anchor lives in an older page — or the newest page is still
      // loading (the store refuses history loads while historyLoading,
      // returning 0 until the initial page lands after a cold runtime spawn).
      // Keep retrying past those transient zeros: the saved position is only
      // restorable once the page containing it has actually arrived.
      void loadMessagesForNavigation(readState.before!).then(() => {
        if (stale()) return;
        settleAndScroll();
        scheduleSessionScoped(attempt, RESTORE_RETRY_MS);
      });
    };
    attempt();
    // Safety net: never leave writes suppressed if the load stalls beyond the
    // retry budget (a long-running load must not block the user's own writes).
    scheduleSessionScoped(releaseWrites, RESTORE_BUDGET_MS + RESTORE_SETTLE_MS + 1000);
  }, [readState, readStateLoading, sessionId, loadMessagesForNavigation, scheduleSessionScoped, scrollToLoadedTarget]);

  // Bookmark jumps reuse the pagination machinery: the target may live in an
  // older page that has not been loaded yet (user and assistant anchors). A
  // bookmark jump supersedes an in-flight reading-position restore.
  const jumpToBookmark = useCallback((id: string) => {
    supersedeRestore();
    followOutputRef.current = false;
    const entry = (messageIndexQuery.data?.messages ?? []).find((candidate) => candidate.id === id);
    if (entry?.before) {
      loadOlderForTarget(entry.before, (loaded) => {
        if (loaded > 0) scheduleSessionScoped(() => scrollToLoadedTarget(id), 0);
        else scrollToLoadedTarget(id);
      });
      return;
    }
    scrollToLoadedTarget(id);
  }, [messageIndexQuery.data?.messages, loadOlderForTarget, scrollToLoadedTarget, cancelRestore]);
  const scrollToBottom = () => {
    // Back-to-latest supersedes the reading-position restore: cancel its
    // retry loop (so the anchor jump cannot yank the viewport back), release
    // its write suppression, and mark the session entry so a late read-state
    // response cannot start a restore either.
    supersedeRestore();
    followOutputRef.current = true;
    const scroller = scrollRef.current;
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smoothScroll() ? "smooth" : "auto" });
      scroller.scrollTop = scroller.scrollHeight;
    }
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: smoothScroll() ? "smooth" : "auto" });
  };
  const model = useModelConfig(workspaceCwd, sessionId);

  useEffect(() => {
    if (activeSessionId) {
      void fetchDynamicCommands(activeSessionId, workspaceCwd);
    } else {
      resetDynamicCommands();
    }
  }, [activeSessionId, workspaceCwd]);

  const research = useResearchLoop(workspaceCwd);
  const composer = useComposer({
    cwd: workspaceCwd,
    conversationKey: sessionId ?? null,
    selectedModel: model.selectedModel,
    reviewingProject,
    setReviewNotice,
    research: { mode: research.mode, draft: research.draft, intent: research.intent },
    onSend: () => {
      // The user sent a message while possibly scrolled up in history: snap
      // back to the newest content so the fresh reply is immediately visible.
      followOutputRef.current = true;
      setShowScrollDown(false);
      // A send supersedes the reading-position restore: cancel its retry
      // timers, invalidate in-flight callbacks, release its write suppression
      // and mark the session entry so a late read-state response cannot start
      // a restore either.
      supersedeRestore();
      const snapToBottom = () => {
        const scroller = scrollRef.current;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      };
      snapToBottom();
      // The optimistic user block lands right after; scroll again once the
      // block list has grown so the new message is actually in view.
      scheduleSessionScoped(snapToBottom, 50);
      scheduleSessionScoped(snapToBottom, 200);
    },
  });
  const { input, setInput, files, setFiles, workspaceReferences } = composer;
  const modelControlsDisabled = working || interactionPending || reviewingProject || model.configuringModel;
  // The reviewer already runs on every settled turn when the workspace opted in, so the manual
  // button would only duplicate it. Until the policy is known, show the manual button: it is the
  // shipped default and the only control that does something when auto review is off.
  const autoReviewOn = useReviewPolicy(workspaceCwd).data?.auto_review === true;

  const renderInteractionPrompt = () => {
    if (pendingQuestionnaire && pendingInteraction?.questionnaire) {
      return (
        <QuestionnairePrompt
          questionnaire={pendingQuestionnaire}
          interaction={pendingInteraction}
          onRespond={(response) => void respondToInteraction(response).catch(() => undefined)}
        />
      );
    }
    if (!pendingInteraction) return null;
    return (
      <InteractionPrompt
        interaction={pendingInteraction}
        onRespond={(response) => void respondToInteraction(response).catch(() => undefined)}
      />
    );
  };

  const handleProjectReview = async () => {
    if (reviewingProject || working || interactionPending) return;
    setReviewingProject(true);
    setReviewNotice(null);
    try {
      const result = await projectKnowledgeApi.review(workspaceCwd, activeSessionId);
      setReviewNotice(result.created > 0 ? `${result.created} update proposal${result.created === 1 ? "" : "s"} added` : result.message);
    } catch (cause) {
      setReviewNotice(cause instanceof Error ? cause.message : t("conversation.reviewError"));
    } finally {
      setReviewingProject(false);
    }
  };

  const hasUserMessage = thread.blocks.some((block) => block.kind === "user");
  // Empty new conversation: welcome copy sits directly above a vertically centered composer.
  const showWelcome = thread.blocks.length === 0 && !working && status !== "connecting" && !research.draft && !research.activeLoop;
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const isNewSession = !hasUserMessage && (activeSession?.name === "New Session" || thread.loaded);
  const title = isNewSession || !activeSessionId
    ? t("conversation.newSession")
    : getSessionName(workspaceCwd, activeSessionId) || activeSession?.name || activeSessionId.slice(0, 8);

  // Workflow starters are entry points for a blank conversation. Once the
  // first turn exists, the composer stays focused on the active conversation
  // instead of continuing to show the onboarding shortcuts.
  const modePicker = thread.blocks.length === 0 && !research.draft && !research.activeLoop
    ? <ResearchModePicker className={showWelcome ? "px-0 pb-0" : undefined} selected={research.mode} disabled={working || interactionPending || reviewingProject || research.busy} onSelect={(mode, prompt) => { const selected = research.mode === mode ? null : mode; research.setMode(selected); research.setPrompt(selected ? prompt : t("conversation.defaultPrompt")); composer.inputRef.current?.focus(); }} />
    : null;

  // Follow-up suggestion chips: shown above the research-mode picker, clicking
  // one drops the suggestion into the composer (the user may tweak or append
  // to it) instead of sending it directly. Not shown on the blank welcome page.
  const suggestionChips = suggestions.length > 0 && !working && !research.draft && !research.activeLoop && !input.trim() ? (
    <div className="mx-auto flex max-w-[760px] flex-wrap gap-2 px-1 pb-2" aria-label={t("conversation.suggestions")}>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          disabled={!model.selectedModel || reviewingProject}
          onClick={() => {
            // Put the suggestion into the composer instead of sending it
            // immediately: the user may want to tweak or append to it.
            setSuggestions([]);
            setInput(suggestion);
            composer.inputRef.current?.focus();
          }}
          className="min-h-9 rounded-full border border-border bg-surface px-3 py-1 text-left text-xs text-muted transition-colors hover:text-text disabled:opacity-50"
        >
          {suggestion}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-faint px-6 pr-24">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn("h-2 w-2 rounded-full shrink-0",
            status === "ready" ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : status === "error" ? "bg-error" : "bg-muted"
          )} title={status} />
          <h1 className="min-w-0 truncate text-[13px] font-medium text-text">{title}</h1>
        </div>
        <div className="relative shrink-0">
          <button
            ref={bookmarksTriggerRef}
            type="button"
            aria-label={t("conversation.bookmarks")}
            aria-haspopup="true"
            aria-expanded={bookmarksOpen}
            aria-controls={bookmarksPanelId}
            onClick={() => setBookmarksOpen((open) => !open)}
            className="relative flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <Bookmark size={14} fill={headerBookmarkCount > 0 ? "currentColor" : "none"} className={cn(headerBookmarkCount > 0 && "text-accent")} />
            {headerBookmarkCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[8px] font-medium leading-none text-accent-fg">
                {headerBookmarkCount}
              </span>
            )}
          </button>
          <ConversationBookmarksPanel
            id={bookmarksPanelId}
            bookmarks={sessionBookmarks}
            loading={bookmarksLoading}
            open={bookmarksOpen}
            onClose={closeBookmarks}
            onJump={jumpToBookmark}
            onAccept={(bookmarkId) => acceptBookmark(bookmarkId)}
            onReject={(bookmarkId) => rejectBookmark(bookmarkId)}
            onDelete={(bookmarkId) => deleteBookmark(bookmarkId)}
            onSuggest={() => proposeBookmarks()}
            suggesting={proposePending}
            proposeResult={proposeResult}
            proposeError={proposeError}
          />
        </div>
      </header>

      {/* Welcome layout: this top region and the spacer below the composer both
          grow equally, so the composer card lands on the vertical centre while
          the welcome copy hangs off its bottom edge. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Thread */}
        <div className={cn("flex-1 overflow-hidden [overflow-anchor:none]", showWelcome && "flex flex-col justify-end")}>
          {/* 824 = 760 composer column + the px-8 gutters, so thread content lines up with the composer's edges.
              w-full is required: an auto horizontal margin on a flex item suppresses the stretch,
              which would shrink this column to its widest child and centre it. */}
          <div className={cn(
            thread.blocks.length > 0
              ? "h-full w-full"
              : cn(
                "mx-auto flex w-full max-w-[824px] flex-col px-8",
                showWelcome ? "gap-3 pb-3 pt-6" : "gap-4 py-6",
              ),
          )}>
            {thread.blocks.length === 0 && !working && status === "connecting" && activeSessionId && (
              <div className="flex items-center gap-2 py-4 text-sm text-muted">
                <Loader2 size={14} className="animate-spin text-accent" />
                {t("conversation.loading")}
              </div>
            )}
            {showWelcome && <ConversationWelcome />}
            {showWelcome && modePicker}
            {thread.blocks.length > 0 ? (
              <Suspense fallback={<div ref={attachScroller} className="h-full overflow-y-auto" />}>
                <LazyVirtuoso
                  key={`${workspaceCwd}:${activeSessionId ?? "new"}`}
                  ref={virtuosoRef}
                  scrollerRef={attachScroller}
                  firstItemIndex={virtualFirstItemIndex}
                  data={blockGroups}
                  initialItemCount={Math.min(blockGroups.length, 20)}
                  startReached={() => void handleLoadOlder()}
                  increaseViewportBy={{ top: 600, bottom: 800 }}
                  context={{ renderInteractionPrompt, working, pendingInteraction }}
                  components={{
                    Header: () => (
                      <div className="mx-auto flex w-full max-w-[824px] flex-col gap-4 px-8 pb-2 pt-6">
                        {historyLoading && (
                          <div className="flex items-center gap-2 text-xs text-muted" role="status">
                            <Loader2 size={13} className="animate-spin text-accent" />
                            Loading earlier messages…
                          </div>
                        )}
                        {research.draft && <ResearchLoopDraftCard draft={research.draft} busy={research.busy} onCancel={() => { research.setDraft(null); research.setMode(null); research.setError(null); }} onConfirm={() => void research.confirm()} />}
                        {research.activeLoop && <ResearchLoopStatusCard loop={research.activeLoop} candidates={research.activeLoop.candidates} busy={research.busy} onRefresh={() => void research.refresh(research.activeLoop!.loop_id)} onAction={(action) => void research.action(action)} onOpenDetails={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/research`)} />}
                        {research.error && <div className="rounded-input border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">{research.error}</div>}
                      </div>
                    ),
                    Footer: ConversationFooter,
                  }}
                  itemContent={(_index, group) => (
                    <div className="mx-auto w-full max-w-[824px] px-8 pb-3">
                      {renderBlockGroup(group, { cwd: workspaceCwd, sessionId: activeSessionId ?? "scratch" }, actionTextByBlock, bookmarkActions)}
                    </div>
                  )}
                />
              </Suspense>
            ) : (
              <>
                {research.draft && <ResearchLoopDraftCard draft={research.draft} busy={research.busy} onCancel={() => { research.setDraft(null); research.setMode(null); research.setError(null); }} onConfirm={() => void research.confirm()} />}
                {research.activeLoop && <ResearchLoopStatusCard loop={research.activeLoop} candidates={research.activeLoop.candidates} busy={research.busy} onRefresh={() => void research.refresh(research.activeLoop!.loop_id)} onAction={(action) => void research.action(action)} onOpenDetails={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/research`)} />}
                {research.error && <div className="rounded-input border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">{research.error}</div>}
                {renderInteractionPrompt()}
                {working && !pendingInteraction && (
                  <div className="flex items-center gap-2 py-4 text-sm text-muted">
                    <Loader2 size={14} className="animate-spin text-accent" />
                    Working…
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Compact conversation minimap: hover a line to preview, click to jump. */}
        {userNavItems.length >= 1 && (
          <ConversationNavRail items={userNavItems} rootRef={scrollRef} onSelect={handleNavSelect} onActiveChange={handleActiveChange} bookmarkedIds={bookmarkedUserIds} observationKey={loadedUserAnchorKey} />
        )}

        {/* Composer */}
        <div className={cn("px-8 shrink-0", showWelcome ? "py-0" : "pb-5 pt-2")}>
          {!showWelcome && (
            <div className="relative mx-auto max-w-[760px]">
              {suggestionChips}
              {modePicker}
              {showScrollDown && (
                <button
                  type="button"
                  aria-label={t("conversation.scrollToLatest")}
                  onClick={scrollToBottom}
                  className="ui-popover absolute -top-10 left-1/2 z-10 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"
                >
                  <ArrowDown size={15} />
                </button>
              )}
            </div>
          )}
          <Suspense fallback={null}>
            <ComposerTodo />
          </Suspense>
          <div
            className={cn(
              "ui-card relative mx-auto max-w-[760px] rounded-card transition-colors",
              composer.dragOver && "border-accent bg-accent/5",
            )}
            onDragOver={(e) => { e.preventDefault(); composer.setDragOver(true); }}
            onDragLeave={() => composer.setDragOver(false)}
            onDrop={composer.handleDrop}
          >
            {workspaceReferences.length > 0 && (
              <div className="border-b border-faint px-3 py-2">
                <div className="flex flex-wrap gap-1.5">
                  {workspaceReferences.map((reference) => (
                    <span key={reference.path} className="flex max-w-full items-center gap-1 rounded-input bg-accent/5 px-2 py-1 font-mono text-[11px] text-text ring-1 ring-accent/20 cursor-pointer hover:bg-accent/10" title={`${t("conversation.clickToInsert")} ${reference.path}`} onClick={() => { const current = input; setInput(current ? `${current} ${reference.path}` : reference.path); }}>
                      {reference.isDir ? <FolderOpen size={11} className="shrink-0 text-accent" /> : <File size={11} className="shrink-0 text-accent" />}
                      <span className="truncate">{reference.path}</span>
                      <button type="button" aria-label={`Remove reference ${reference.name}`} onClick={(e) => { e.stopPropagation(); removeWorkspaceReference(workspaceCwd, reference.path); }} className="shrink-0 text-muted hover:text-error">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                {files.map((f, i) => (
                  <span key={i} className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 font-mono text-[11px] text-text ring-1 ring-border">
                    {f.name}
                    <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-muted hover:text-error">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <SlashCommandMenu
              input={input}
              onSelect={setInput}
            />
            <MentionComposer
              cwd={workspaceCwd}
              value={input}
              mentions={composer.mentions}
              onChange={(value, mentions) => { setInput(value); composer.setMentions(mentions); }}
              onKeyDown={composer.handleKeyDown}
              onCompositionStart={() => { composer.composingRef.current = true; }}
              onCompositionEnd={() => { setTimeout(() => { composer.composingRef.current = false; }, 0); }}
              placeholder={composer.dragOver ? "Drop files here…" : research.prompt}
              inputRef={composer.inputRef}
            />
            <div className="flex items-center justify-between gap-2 px-3 pb-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  onClick={() => composer.fileInputRef.current?.click()}
                  aria-label={t("conversation.attach")}
                  title={t("conversation.attach")}
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted hover:text-text hover:bg-surface-2"
                >
                  <Plus size={15} />
                </button>
                {autoReviewOn ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/knowledge`)}
                    className="flex min-h-7 items-center gap-1 rounded-input border border-ok/40 bg-ok/10 px-2 py-1 text-xs text-ok hover:bg-ok/15"
                    title={t("conversation.autoReviewOnTitle")}
                  >
                    <Sparkles size={13} />
                    {t("conversation.autoReviewOn")}
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label="Review"
                    onClick={() => void handleProjectReview()}
                    disabled={working || interactionPending || reviewingProject}
                    className="flex min-h-7 items-center gap-1 rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:cursor-wait disabled:opacity-50"
                    title={t("conversation.reviewTitle")}
                  >
                    {reviewingProject ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                    <span className="composer-review-label">Review</span>
                  </button>
                )}
                {model.modelError && <span className="max-w-[180px] truncate text-[10px] text-error" title={model.modelError}>{model.modelError}</span>}
                {reviewNotice && <span className="max-w-[220px] truncate text-[10px] text-muted" title={reviewNotice}>{reviewNotice}</span>}
              </div>
              <input ref={composer.fileInputRef} type="file" multiple className="hidden" onChange={composer.handleFilePick} />
              <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
                {model.models.length > 0 && (
                  <ModelControlMenu
                    models={model.models}
                    selectedModel={model.selectedModel}
                    thinking={model.thinking}
                    thinkingLevels={model.thinkingLevels}
                    contextTokens={contextTokens}
                    contextWindow={contextWindow || model.selectedModelInfo?.context_window}
                    contextPercent={contextPercent}
                    compactionEnabled={compactionEnabled}
                    compactionThresholdPercent={compactionThresholdPercent}
                    disabled={modelControlsDisabled}
                    onModelChange={model.handleModelChange}
                    onThinkingChange={model.handleThinkingChange}
                  />
                )}
                {working ? (
                  <button aria-label="Stop generation" onClick={() => void abort().catch(() => undefined)} className="h-7 w-7 rounded-input bg-accent text-accent-fg flex items-center justify-center hover:bg-error transition-colors">
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    aria-label="Send message"
                    onClick={composer.handleSend}
                    disabled={working || interactionPending || (!model.selectedModel && !research.mode) || reviewingProject || research.busy || (!activeSessionId && status === "connecting") || (!input.trim() && files.length === 0 && workspaceReferences.length === 0)}
                    className={cn(
                      "h-7 w-7 rounded-input flex items-center justify-center",
                      ((model.selectedModel || research.mode) && !interactionPending && !reviewingProject && !research.busy && (activeSessionId || status !== "connecting") && (input.trim() || files.length > 0 || workspaceReferences.length > 0)) ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted cursor-default",
                    )}
                  >
                    <ArrowUp size={15} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {showWelcome && <div className="flex-1" aria-hidden />}
      </div>
    </div>
  );
}
