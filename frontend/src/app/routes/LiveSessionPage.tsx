import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ComponentType, ReactNode, Ref } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
import { ConversationComposer } from "../../components/conversation/ConversationComposer";
import { ConversationWelcome } from "../../components/conversation/ConversationWelcome";
import { InteractionPrompt } from "../../components/conversation/InteractionPrompt";
import { QuestionnairePrompt } from "../../components/conversation/QuestionnairePrompt";
import { groupBlocks, renderBlockGroup } from "../../components/conversation/ConversationBlocks";
import { ConversationNavRail, type ConversationNavItem } from "../../components/conversation/ConversationNavRail";
import { SessionExecutionButton } from "../../components/conversation/SessionExecutionButton";
import { visibleUserMessage } from "../../lib/files";
import { useTranslation } from "react-i18next";
import { ResearchLoopDraftCard, ResearchLoopStatusCard, ResearchModePicker } from "../../components/conversation/ResearchLoopControls";
import { useTurnEffects } from "../../hooks/useTurnEffects";
import { useModelConfig } from "../../hooks/useModelConfig";
import { useResearchLoop } from "../../hooks/useResearchLoop";
import { useComposer } from "../../hooks/useComposer";
import { useConversationScroll } from "../../hooks/useConversationScroll";
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

  const blockGroups = useMemo(() => groupBlocks(thread.blocks), [thread.blocks]);
  // Copy-button eligibility computed across the WHOLE thread (not per group):
  // agentActionTextByBlock needs the trailing tool blocks after an agent block
  // to decide whether it is the final answer. A per-group computation would
  // give every agent block a copy button.
  const actionTextByBlock = useMemo(() => agentActionTextByBlock(thread.blocks), [thread.blocks]);

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

  const scroll = useConversationScroll({
    sessionId,
    workspaceCwd,
    activeSessionId,
    focusedBlockId,
    showRuns,
    working,
    blocks: thread.blocks,
    blockGroups,
    userNavItems,
    historyHasMore,
    historyLoading,
    loadOlderMessages,
    loadMessagesForNavigation,
  });
  const { scrollRef, virtuosoRef, showScrollDown, virtualFirstItemIndex, attachScroller, handleLoadOlder, handleNavSelect, scrollToBottom } = scroll;

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
      // Follow-ups belong to the completed turn. Once the user continues the
      // conversation they should not linger beneath the previous answer.
      setSuggestions([]);
      scroll.startNewTurn();
    },
  });
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

  // Empty new conversation: welcome copy sits directly above a vertically centered composer.
  const showWelcome = thread.blocks.length === 0 && !working && status !== "connecting" && !research.draft && !research.activeLoop;
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  // A paged history can be loaded without its user messages. `thread.loaded`
  // only means that a page arrived; it does not mean this is a new session.
  const isNewSession = !activeSessionId || (thread.blocks.length === 0 && (!activeSession || activeSession.name === "New Session"));
  const title = isNewSession
    ? t("conversation.newSession")
    : getSessionName(workspaceCwd, activeSessionId) || activeSession?.name || activeSessionId.slice(0, 8);

  // Workflow starters are entry points for a blank conversation. Once the
  // first turn exists, the composer stays focused on the active conversation
  // instead of continuing to show the onboarding shortcuts.
  const modePicker = thread.blocks.length === 0 && !research.draft && !research.activeLoop
    ? <ResearchModePicker className={showWelcome ? "px-0 pb-0" : undefined} selected={research.mode} disabled={working || interactionPending || reviewingProject || research.busy} onSelect={(mode, prompt) => { const selected = research.mode === mode ? null : mode; research.setMode(selected); research.setPrompt(selected ? prompt : t("conversation.defaultPrompt")); composer.inputRef.current?.focus(); }} />
    : null;
  const suggestionAnchorBlockId = (() => {
    if (suggestions.length === 0) return null;
    const agentIndex = thread.blocks.findLastIndex((block) => block.kind === "agent");
    if (agentIndex < 0) return null;
    const agent = thread.blocks[agentIndex];
    const followingBlock = thread.blocks[agentIndex + 1];
    // turn.artifacts is folded immediately after the final assistant message.
    // Anchor follow-ups to that block when present so generated-file cards
    // appear before the suggestions; otherwise keep them under the message.
    if (followingBlock?.kind === "artifact-summary") return followingBlock.id;
    return agent?.id ?? null;
  })();
  const showSuggestions = suggestions.length > 0
    && !working
    && !research.draft
    && !research.activeLoop
    && !composer.input.trim();

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
                      {showSuggestions && group.some((block) => block.id === suggestionAnchorBlockId) && (
                        <div className="mt-3 flex flex-wrap gap-2" aria-label={t("conversation.suggestions")}>
                          {suggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              disabled={!model.selectedModel || reviewingProject}
                              onClick={() => {
                                // Fill the composer instead of sending immediately so
                                // the user can edit the suggested follow-up first.
                                setSuggestions([]);
                                composer.setInput(suggestion);
                                composer.inputRef.current?.focus();
                              }}
                              className="min-h-9 rounded-full border border-border bg-surface px-3 py-1 text-left text-xs text-muted transition-colors hover:text-text disabled:opacity-50"
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      )}
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

        <ConversationComposer
          workspaceCwd={workspaceCwd}
          status={status}
          activeSessionId={activeSessionId}
          sessionStats={sessionStats}
          contextTokens={contextTokens}
          contextWindow={contextWindow}
          contextPercent={contextPercent}
          compactionEnabled={compactionEnabled}
          compactionThresholdPercent={compactionThresholdPercent}
          working={working}
          interactionPending={interactionPending}
          reviewingProject={reviewingProject}
          reviewNotice={reviewNotice}
          autoReviewOn={autoReviewOn}
          modelControlsDisabled={modelControlsDisabled}
          showWelcome={showWelcome}
          showScrollDown={showScrollDown}
          composer={composer}
          model={model}
          research={research}
          modePicker={modePicker}
          onScrollToBottom={scrollToBottom}
          onReview={() => void handleProjectReview()}
          onAbort={abort}
          onRemoveWorkspaceReference={removeWorkspaceReference}
        />

        {showWelcome && <div className="flex-1" aria-hidden />}
      </div>
      </>
      )}
    </div>
  );
}
