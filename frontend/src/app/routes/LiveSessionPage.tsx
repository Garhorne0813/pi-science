import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode, Ref } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, Square, Plus, Sparkles, X, File, FolderOpen } from "lucide-react";
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
import { ConversationStatsLine } from "../../components/conversation/ConversationStatsLine";
import { SessionExecutionButton } from "../../components/conversation/SessionExecutionButton";
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
const SessionRunsPage = lazy(() => import("./RunsPage").then((m) => ({ default: m.RunsPage })));

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
    <div className="mx-auto flex w-full max-w-[calc(var(--conversation-content-width)+4rem)] flex-col gap-4 px-8 pb-6 pt-2">
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
  const [searchParams, setSearchParams] = useSearchParams();
  const showRuns = searchParams.get("view") === "runs";
  const focusedBlockId = searchParams.get("focus");
  // Field-level selectors, not a whole-store subscription: a streamed token only
  // touches `thread`/`working`, so nothing that reads the other fields re-renders.
  const status = useRuntimeStore((s) => s.status);
  const sessionStats = useRuntimeStore((s) => s.sessionStats);
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
  const locatedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    return () => {
      for (const handle of scrollTimersRef.current) window.clearTimeout(handle);
      scrollTimersRef.current = [];
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
    queryFn: () => getClient().getUserMessageIndex(sessionId!, workspaceCwd),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  }, queryClient);

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
  }, []);

  const attachScroller = useCallback((element: Window | HTMLElement | null) => {
    if (scrollRef.current) scrollRef.current.removeEventListener("scroll", handleThreadScroll);
    scrollRef.current = element instanceof HTMLElement ? element as HTMLDivElement : null;
    if (scrollRef.current) {
      // Keep the stable class hook used by the conversation rail and by
      // integrations that locate the active conversation scroller.
      scrollRef.current.classList.add("conversation-scroller", "overflow-y-auto");
      scrollRef.current.addEventListener("scroll", handleThreadScroll);
    }
  }, [handleThreadScroll]);

  useLayoutEffect(() => {
    if (followOutputRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    }
  }, [thread.blocks]);

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
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    }
    wasWorking.current = working;
  }, [working]);

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

  const userNavItems = useMemo<ConversationNavItem[]>(() => {
    const loadedUsers = thread.blocks.filter((block): block is Extract<ThreadBlock, { kind: "user" }> => block.kind === "user");
    const loadedById = new Map(loadedUsers.map((block) => [block.id, block]));
    const seen = new Set<string>();
    const toItem = (id: string, text: string, before?: string): ConversationNavItem => {
      const visible = visibleUserMessage(text);
      return { id, label: (visible || t("conversation.attachment")).slice(0, 120), full: text, before };
    };
    const indexed = (messageIndexQuery.data?.messages ?? []).map((entry) => {
      const loaded = loadedById.get(entry.id);
      seen.add(entry.id);
      return toItem(entry.id, loaded?.text ?? entry.text, loaded ? undefined : entry.before);
    });
    const live = loadedUsers
      .filter((block) => !seen.has(block.id))
      .map((block) => toItem(block.id, block.text));
    return [...indexed, ...live];
  }, [messageIndexQuery.data?.messages, t, thread.blocks]);

  const smoothScroll = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Runs fn after `delay` only while the page still shows the same session;
  // every pending handle is tracked so newer interactions/unmount can cancel.
  const scheduleSessionScoped = (fn: () => void, delay: number) => {
    const scheduledSession = sessionRef.current;
    const handle = window.setTimeout(() => {
      if (sessionRef.current !== scheduledSession) return;
      fn();
    }, delay);
    scrollTimersRef.current.push(handle);
  };
  const cancelPendingScrollTimers = () => {
    for (const handle of scrollTimersRef.current) window.clearTimeout(handle);
    scrollTimersRef.current = [];
  };
  const threadBlockElement = (id: string) => {
    const userMessage = document.getElementById(`user-msg-${id}`);
    if (userMessage) return userMessage;
    return Array.from(document.querySelectorAll<HTMLElement>("[data-thread-block-ids]"))
      .find((element) => element.dataset.threadBlockIds?.split(" ").includes(id)) ?? null;
  };
  const highlightThreadBlock = (id: string) => {
    const target = threadBlockElement(id);
    if (!target) return;
    target.classList.add("execution-focus-highlight");
    scheduleSessionScoped(() => target.classList.remove("execution-focus-highlight"), 2_400);
  };
  const scrollToLoadedTarget = (id: string, highlight = false) => {
    const scrollToExact = () => {
      const target = threadBlockElement(id);
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
      const target = threadBlockElement(id);
      if (target) {
        const r = target.getBoundingClientRect();
        const vr = scrollerNow.getBoundingClientRect();
        const offset = r.top - vr.top;
        if (offset >= -20 && offset < 300) {
          if (highlight) highlightThreadBlock(id);
          return;
        }
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
      scheduleSessionScoped(() => {
        scrollToExact();
        if (highlight) highlightThreadBlock(id);
      }, 350);
    } else {
      if (scrollToExact() && highlight) highlightThreadBlock(id);
    }
  };
  const handleNavSelect = (id: string) => {
    // Stop the follow-output effect from yanking the viewport back to the bottom.
    followOutputRef.current = false;
    // A new navigation supersedes any pending correction timers from a
    // previous one (rapid consecutive clicks, session switch).
    cancelPendingScrollTimers();
    const target = userNavItems.find((item) => item.id === id);
    if (target?.before) {
      void loadMessagesForNavigation(target.before).then((loadedMessages) => {
        if (loadedMessages > 0) scheduleSessionScoped(() => scrollToLoadedTarget(id), 0);
      });
      return;
    }
    scrollToLoadedTarget(id);
  };

  useEffect(() => {
    if (!focusedBlockId) {
      locatedFocusRef.current = null;
      return;
    }
    if (showRuns || !activeSessionId) return;
    const focusKey = `${activeSessionId}:${focusedBlockId}`;
    if (locatedFocusRef.current === focusKey) return;
    let cancelled = false;

    const locate = async () => {
      followOutputRef.current = false;
      cancelPendingScrollTimers();
      let previousGroupCount = groupBlocks(useRuntimeStore.getState().thread.blocks).length;
      let state = useRuntimeStore.getState();
      while (!state.thread.blocks.some((block) => block.id === focusedBlockId) && state.historyHasMore) {
        const loadedMessages = await state.loadOlderMessages();
        if (cancelled || loadedMessages === 0) return;
        const nextGroupCount = groupBlocks(useRuntimeStore.getState().thread.blocks).length;
        const addedGroups = Math.max(0, nextGroupCount - previousGroupCount);
        if (addedGroups > 0) setVirtualFirstItemIndex((current) => current - addedGroups);
        previousGroupCount = nextGroupCount;
        state = useRuntimeStore.getState();
      }
      if (cancelled || !state.thread.blocks.some((block) => block.id === focusedBlockId)) return;
      locatedFocusRef.current = focusKey;
      scheduleSessionScoped(() => scrollToLoadedTarget(focusedBlockId, true), 0);
    };

    void locate();
    return () => { cancelled = true; };
  }, [activeSessionId, focusedBlockId, showRuns, thread.blocks]);
  const scrollToBottom = () => {
    followOutputRef.current = true;
    const scroller = scrollRef.current;
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: smoothScroll() ? "smooth" : "auto" });
      scroller.scrollTop = scroller.scrollHeight;
    }
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: smoothScroll() ? "smooth" : "auto" });
  };
  const model = useModelConfig(workspaceCwd, sessionId);

  // Whole-session stats: the SSE `session.stats` event keeps the store fresh
  // after every settled turn; a REST read covers refresh/mount before the
  // first turn of the current page load.
  useEffect(() => {
    if (!activeSessionId) {
      useRuntimeStore.setState({ sessionStats: null });
      return;
    }
    let cancelled = false;
    void getClient()
      .getSessionStats(activeSessionId, workspaceCwd)
      .then((stats) => { if (!cancelled) useRuntimeStore.setState({ sessionStats: stats }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeSessionId, workspaceCwd]);

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
      // A new send supersedes pending corrections from an earlier one.
      cancelPendingScrollTimers();
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
    <div className="mx-auto flex max-w-[var(--conversation-composer-width)] flex-wrap gap-2 px-1 pb-2" aria-label={t("conversation.suggestions")}>
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
      <header className="flex h-11 shrink-0 items-center border-b border-faint px-6 pr-24">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn("h-2 w-2 rounded-full shrink-0",
            status === "ready" ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : status === "error" ? "bg-error" : "bg-muted"
          )} title={status} />
          <h1 className="min-w-0 truncate text-[13px] font-medium text-text">{title}</h1>
          <SessionExecutionButton
            cwd={workspaceCwd}
            sessionId={sessionId ?? activeSessionId ?? undefined}
            active={showRuns}
            onToggle={() => {
              const next = new URLSearchParams(searchParams);
              if (showRuns) {
                next.delete("view");
                next.delete("execution");
              } else {
                next.delete("focus");
                next.set("view", "runs");
              }
              setSearchParams(next);
            }}
          />
        </div>
      </header>

      {showRuns ? (
        <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center"><Loader2 size={18} className="animate-spin text-muted" /></div>}>
          <SessionRunsPage sessionId={sessionId ?? activeSessionId ?? undefined} />
        </Suspense>
      ) : (
      <>
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
                "mx-auto flex w-full max-w-[calc(var(--conversation-content-width)+4rem)] flex-col px-8",
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
                      <div className="mx-auto flex w-full max-w-[calc(var(--conversation-content-width)+4rem)] flex-col gap-4 px-8 pb-2 pt-6">
                        {historyLoading && (
                          <div className="flex items-center gap-2 text-xs text-muted" role="status">
                            <Loader2 size={13} className="animate-spin text-accent" />
                            Loading earlier messages…
                          </div>
                        )}
                        {research.draft && <ResearchLoopDraftCard draft={research.draft} busy={research.busy} onCancel={() => { research.setDraft(null); research.setMode(null); research.setError(null); }} onConfirm={() => void research.confirm()} />}
                        {research.activeLoop && <ResearchLoopStatusCard loop={research.activeLoop} candidates={research.activeLoop.candidates} busy={research.busy} onRefresh={() => void research.refresh(research.activeLoop!.loop_id)} onAction={(action) => void research.action(action)} onOpenDetails={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/research`)} />}
                        {research.error && <div className="rounded-input border border-error/30 bg-error/5 px-3 py-2 text-xs text-error-text">{research.error}</div>}
                      </div>
                    ),
                    Footer: ConversationFooter,
                  }}
                  itemContent={(_index, group) => (
                    <div className="mx-auto w-full max-w-[calc(var(--conversation-content-width)+4rem)] px-8 pb-3">
                      {renderBlockGroup(group, { cwd: workspaceCwd, sessionId: activeSessionId ?? "scratch" }, actionTextByBlock)}
                    </div>
                  )}
                />
              </Suspense>
            ) : (
              <>
                {research.draft && <ResearchLoopDraftCard draft={research.draft} busy={research.busy} onCancel={() => { research.setDraft(null); research.setMode(null); research.setError(null); }} onConfirm={() => void research.confirm()} />}
                {research.activeLoop && <ResearchLoopStatusCard loop={research.activeLoop} candidates={research.activeLoop.candidates} busy={research.busy} onRefresh={() => void research.refresh(research.activeLoop!.loop_id)} onAction={(action) => void research.action(action)} onOpenDetails={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/research`)} />}
                {research.error && <div className="rounded-input border border-error/30 bg-error/5 px-3 py-2 text-xs text-error-text">{research.error}</div>}
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
          <ConversationNavRail items={userNavItems} rootRef={scrollRef} onSelect={handleNavSelect} />
        )}

        {/* Composer */}
        <div className={cn("px-8 shrink-0", showWelcome ? "py-0" : "pb-1 pt-1")}>
          {!showWelcome && (
            <div className="relative mx-auto max-w-[var(--conversation-composer-width)]">
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
          <div className="relative mx-auto max-w-[var(--conversation-composer-width)]">
            {/* Fixed 36px fade band above the composer card (reference:
                ConversationRoot composer seat gradient). The card sits at the
                bottom of the column, so the band softens the transcript edge
                scrolling into it. Rendered only when nothing (suggestion chips,
                research mode picker) sits above the card: with such content the
                band visually covers those controls. */}
            {!modePicker && !suggestionChips && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-full h-[var(--composer-fade-height)] bg-gradient-to-t from-[var(--bg)] to-transparent"
              />
            )}
            <div
              className={cn(
                "ui-card relative mx-auto max-w-[var(--conversation-composer-width)] rounded-composer shadow-composer transition-colors",
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
                      <button type="button" aria-label={`Remove reference ${reference.name}`} onClick={(e) => { e.stopPropagation(); removeWorkspaceReference(workspaceCwd, reference.path); }} className="shrink-0 text-muted hover:text-error-text">
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
                    <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-muted hover:text-error-text">
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
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <Plus size={15} />
                </button>
                {autoReviewOn ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/knowledge`)}
                    className="flex min-h-7 items-center gap-1 rounded-input border border-ok/40 bg-ok/10 px-2 py-1 text-xs text-ok-text hover:bg-ok/15"
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
                {model.modelError && <span className="max-w-[180px] truncate text-[10px] text-error-text" title={model.modelError}>{model.modelError}</span>}
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
                  <button aria-label="Stop generation" onClick={() => void abort().catch(() => undefined)} className="flex h-[var(--send-button-size)] w-[var(--send-button-size)] items-center justify-center rounded-full bg-accent-fill text-accent-fg transition-colors hover:bg-error-fill">
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    aria-label="Send message"
                    onClick={composer.handleSend}
                    disabled={working || interactionPending || (!model.selectedModel && !research.mode) || reviewingProject || research.busy || (!activeSessionId && status === "connecting") || (!input.trim() && files.length === 0 && workspaceReferences.length === 0)}
                    className={cn(
                      "flex h-[var(--send-button-size)] w-[var(--send-button-size)] items-center justify-center rounded-full",
                      ((model.selectedModel || research.mode) && !interactionPending && !reviewingProject && !research.busy && (activeSessionId || status !== "connecting") && (input.trim() || files.length > 0 || workspaceReferences.length > 0)) ? "bg-accent-fill text-accent-fg" : "bg-surface-2 text-muted cursor-default",
                    )}
                  >
                    <ArrowUp size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
          </div>
          {!showWelcome && <ConversationStatsLine stats={sessionStats} />}
        </div>

        {showWelcome && <div className="flex-1" aria-hidden />}
      </div>
      </>
      )}
    </div>
  );
}
