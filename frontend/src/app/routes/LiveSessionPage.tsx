import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowUp, Loader2, Square, Plus, Sparkles, X, File, FolderOpen } from "lucide-react";
import { getSessionName } from "../../lib/pi-science-client";
import { useRuntimeStore } from "../../lib/runtime-store";
import { useUiStore } from "../../lib/store";
import { cn } from "../../lib/cn";
import { useRequiredWorkspaceCwd } from "../../lib/workspace-context";
import { projectKnowledgeApi } from "../../lib/project-knowledge";
import { fetchDynamicCommands, resetDynamicCommands } from "../../lib/slash-commands";
import { SlashCommandMenu } from "../../components/SlashCommandMenu";
import { ConversationWelcome } from "../../components/conversation/ConversationWelcome";
import { ModelControlMenu } from "../../components/conversation/ModelControlMenu";
import { InteractionPrompt } from "../../components/conversation/InteractionPrompt";
import { renderBlocks } from "../../components/conversation/ConversationBlocks";
import { useTranslation } from "react-i18next";
import { ResearchLoopDraftCard, ResearchLoopStatusCard, ResearchModePicker } from "../../components/conversation/ResearchLoopControls";
import { useTurnEffects } from "../../hooks/useTurnEffects";
import { useModelConfig } from "../../hooks/useModelConfig";
import { useResearchLoop } from "../../hooks/useResearchLoop";
import { useComposer } from "../../hooks/useComposer";

export function LiveSessionPage() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const navigate = useNavigate();
  // Field-level selectors, not a whole-store subscription: a streamed token only
  // touches `thread`/`working`, so nothing that reads the other fields re-renders.
  const status = useRuntimeStore((s) => s.status);
  const thread = useRuntimeStore((s) => s.thread);
  const sessions = useRuntimeStore((s) => s.sessions);
  const working = useRuntimeStore((s) => s.working);
  const connect = useRuntimeStore((s) => s.connect);
  const disconnect = useRuntimeStore((s) => s.disconnect);
  const sendPrompt = useRuntimeStore((s) => s.sendPrompt);
  const abort = useRuntimeStore((s) => s.abort);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const contextTokens = useRuntimeStore((s) => s.contextTokens);
  const contextWindow = useRuntimeStore((s) => s.contextWindow);
  const contextPercent = useRuntimeStore((s) => s.contextPercent);
  const compactionEnabled = useRuntimeStore((s) => s.compactionEnabled);
  const compactionThresholdPercent = useRuntimeStore((s) => s.compactionThresholdPercent);
  const pendingInteraction = useRuntimeStore((s) => s.pendingInteraction);
  const respondToInteraction = useRuntimeStore((s) => s.respondToInteraction);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const [reviewingProject, setReviewingProject] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const removeWorkspaceReference = useUiStore((state) => state.removeWorkspaceReference);

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

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && followOutputRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [thread.blocks]);

  const handleThreadScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followOutputRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  };

  const { suggestions, setSuggestions } = useTurnEffects(working, thread.blocks);
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
    selectedModel: model.selectedModel,
    onModelCommand: model.handleModelChange,
    reviewingProject,
    setReviewNotice,
    research: { mode: research.mode, draft: research.draft, intent: research.intent },
  });
  const { input, setInput, files, setFiles, workspaceReferences } = composer;
  const modelControlsDisabled = working || reviewingProject || model.configuringModel;

  const handleProjectReview = async () => {
    if (reviewingProject || working) return;
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

  // Rendered above the composer card in both layouts, so it lives in a variable:
  // in the welcome layout it belongs to the growing top region (otherwise its
  // height would push the composer card off the vertical centre).
  const modePicker = isNewSession && !research.draft && !research.activeLoop
    ? <ResearchModePicker className={showWelcome ? "px-0 pb-0" : undefined} selected={research.mode} disabled={working || reviewingProject || research.busy} onSelect={(mode, prompt) => { const selected = research.mode === mode ? null : mode; research.setMode(selected); research.setPrompt(selected ? prompt : t("conversation.defaultPrompt")); composer.inputRef.current?.focus(); }} />
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between h-12 px-6 border-b border-faint shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={cn("h-2 w-2 rounded-full shrink-0",
            status === "ready" ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : status === "error" ? "bg-error" : "bg-muted"
          )} title={status} />
          <h1 className="min-w-0 truncate text-[13px] font-medium text-text">{title}</h1>
        </div>
      </header>

      {/* Welcome layout: this top region and the spacer below the composer both
          grow equally, so the composer card lands on the vertical centre while
          the welcome copy hangs off its bottom edge. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Thread */}
        <div ref={scrollRef} onScroll={handleThreadScroll} className={cn("flex-1 overflow-y-auto [overflow-anchor:none]", showWelcome && "flex flex-col justify-end")}>
          {/* 824 = 760 composer column + the px-8 gutters, so thread content lines up with the composer's edges.
              w-full is required: an auto horizontal margin on a flex item suppresses the stretch,
              which would shrink this column to its widest child and centre it. */}
          <div className={cn("mx-auto w-full max-w-[824px] flex flex-col px-8", showWelcome ? "gap-3 pt-6 pb-3" : "gap-4 py-6")}>
            {thread.blocks.length === 0 && !working && status === "connecting" && activeSessionId && (
              <div className="flex items-center gap-2 py-4 text-sm text-muted">
                <Loader2 size={14} className="animate-spin text-accent" />
                {t("conversation.loading")}
              </div>
            )}
            {showWelcome && <ConversationWelcome />}
            {showWelcome && modePicker}
            {research.draft && <ResearchLoopDraftCard draft={research.draft} busy={research.busy} onChange={research.setDraft} onCancel={() => { research.setDraft(null); research.setMode(null); research.setError(null); }} onConfirm={() => void research.confirm()} />}
            {research.activeLoop && <ResearchLoopStatusCard loop={research.activeLoop} candidates={research.activeLoop.candidates} busy={research.busy} onRefresh={() => void research.refresh(research.activeLoop!.loop_id)} onAction={(action) => void research.action(action)} onOpenDetails={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/research`)} />}
            {research.error && <div className="rounded-input border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">{research.error}</div>}
            {renderBlocks(thread.blocks, { cwd: workspaceCwd, sessionId: activeSessionId ?? "scratch" })}
            {pendingInteraction && (
              <InteractionPrompt
                interaction={pendingInteraction}
                onRespond={(response) => void respondToInteraction(response).catch(() => undefined)}
              />
            )}
            {working && !pendingInteraction && (
              <div className="flex items-center gap-2 text-sm text-muted py-4">
                <Loader2 size={14} className="animate-spin text-accent" />
                Working…
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className={cn("px-8 shrink-0", showWelcome ? "py-0" : "pb-5 pt-2")}>
          {!showWelcome && modePicker && <div className="mx-auto max-w-[760px]">{modePicker}</div>}
          {suggestions.length > 0 && !working && !research.draft && !research.activeLoop && !input.trim() && (
            <div className="mx-auto flex max-w-[760px] flex-wrap gap-2 px-1 pb-2" aria-label={t("conversation.suggestions")}>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={!model.selectedModel || reviewingProject}
                  onClick={() => { setSuggestions([]); void sendPrompt(suggestion).catch(() => undefined); }}
                  className="min-h-9 rounded-full border border-border bg-surface px-3 py-1 text-left text-xs text-muted transition-colors hover:text-text disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          <div
            className={cn(
              "relative mx-auto max-w-[760px] rounded-card border bg-surface shadow-card transition-colors",
              composer.dragOver ? "border-accent bg-accent/5" : "border-border",
            )}
            onDragOver={(e) => { e.preventDefault(); composer.setDragOver(true); }}
            onDragLeave={() => composer.setDragOver(false)}
            onDrop={composer.handleDrop}
          >
            {workspaceReferences.length > 0 && (
              <div className="border-b border-faint px-3 py-2">
                <div className="flex flex-wrap gap-1.5">
                  {workspaceReferences.map((reference) => (
                    <span key={reference.path} className="flex max-w-full items-center gap-1 rounded-input bg-accent/5 px-2 py-1 font-mono text-[11px] text-text ring-1 ring-accent/20" title={reference.path}>
                      {reference.isDir ? <FolderOpen size={11} className="shrink-0 text-accent" /> : <File size={11} className="shrink-0 text-accent" />}
                      <span className="truncate">{reference.path}</span>
                      <button type="button" aria-label={`Remove reference ${reference.name}`} onClick={() => removeWorkspaceReference(workspaceCwd, reference.path)} className="shrink-0 text-muted hover:text-error">
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
              onDismiss={() => setInput("")}
            />
            <textarea
              ref={composer.inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={composer.handleKeyDown}
              onCompositionStart={() => { composer.composingRef.current = true; }}
              onCompositionEnd={() => { setTimeout(() => { composer.composingRef.current = false; }, 0); }}
              placeholder={composer.dragOver ? "Drop files here…" : research.prompt}
              rows={2}
              className="max-h-[160px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-text outline-none placeholder:text-muted"
            />
            <div className="flex items-center justify-between gap-2 px-3 pb-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <button
                  onClick={() => composer.fileInputRef.current?.click()}
                  aria-label={t("conversation.attach")}
                  title={t("conversation.attach")}
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted hover:text-text hover:bg-surface-2"
                >
                  <Plus size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleProjectReview()}
                  disabled={working || reviewingProject}
                  className="flex min-h-7 items-center gap-1 rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:cursor-wait disabled:opacity-50"
                  title="Review this conversation for durable project knowledge"
                >
                  {reviewingProject ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  Review
                </button>
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
                    disabled={(!model.selectedModel && !research.mode) || reviewingProject || research.busy || (!activeSessionId && status === "connecting") || (!input.trim() && files.length === 0 && workspaceReferences.length === 0)}
                    className={cn(
                      "h-7 w-7 rounded-input flex items-center justify-center",
                      ((model.selectedModel || research.mode) && !reviewingProject && !research.busy && (activeSessionId || status !== "connecting") && (input.trim() || files.length > 0 || workspaceReferences.length > 0)) ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted cursor-default",
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
