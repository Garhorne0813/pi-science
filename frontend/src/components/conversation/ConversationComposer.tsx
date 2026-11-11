import { McpDiagnosticsNotice } from "./McpDiagnosticsNotice";
import { ApprovalModeMenu } from "./ApprovalModeMenu";
import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, File, FolderOpen, Loader2, Plus, Sparkles, Square, X } from "lucide-react";
import type { QueuedMessage, SessionStats } from "../../lib/client/pi-science-client";
import type { useComposer } from "../../hooks/useComposer";
import type { useModelConfig } from "../../hooks/useModelConfig";
import type { useAutoResearch } from "../../hooks/useAutoResearch";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { findLocalPromptRequest, promptContentDigest } from "../../lib/client/prompt-request-cache";
import { ConversationStatsLine } from "./ConversationStatsLine";
import { MessageQuoteCard } from "./MessageQuoteCard";
import { MentionComposer } from "./MentionComposer";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";
import { ModelControlMenu } from "./ModelControlMenu";
import { useFeedback } from "../feedback/feedback-context";
import { useMessageQuoteStore } from "../../lib/conversation/message-quote";
import { composeQuotedPrompt } from "../../lib/conversation/quoted-message";
import { cn, useUiStore } from "../../lib/ui";


/** Stable empty list: a fresh array in a store selector re-renders forever. */
const NO_QUEUED_MESSAGES: QueuedMessage[] = [];

const ComposerTodo = lazy(() => import("../todo/ComposerTodo").then((module) => ({ default: module.ComposerTodo })));

type ComposerState = ReturnType<typeof useComposer>;
type ModelState = ReturnType<typeof useModelConfig>;
type ResearchState = ReturnType<typeof useAutoResearch>;

export interface ConversationComposerProps {
  workspaceCwd: string;
  status: string;
  activeSessionId: string | null;
  sessionStats: SessionStats | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  compactionEnabled: boolean;
  compactionThresholdPercent: number | null;
  working: boolean;
  promptDeliveryNotice: "pending" | "indeterminate" | null;
  interactionPending: boolean;
  reviewingProject: boolean;
  reviewNotice: string | null;
  autoReviewOn: boolean;
  modelControlsDisabled: boolean;
  showWelcome: boolean;
  showScrollDown: boolean;
  composer: ComposerState;
  model: ModelState;
  research: ResearchState;
  onScrollToBottom: () => void;
  onReview: () => void;
  onAbort: () => Promise<unknown>;
  onRemoveWorkspaceReference: (cwd: string, path: string) => void;
}

/** The composer seat is kept separate from the route so streamed transcript
 * updates do not make the page's orchestration code own every control detail. */
export function ConversationComposer({ workspaceCwd, status, activeSessionId, sessionStats, contextTokens, contextWindow, contextPercent, compactionEnabled, compactionThresholdPercent, working, promptDeliveryNotice, interactionPending, reviewingProject, reviewNotice, autoReviewOn, modelControlsDisabled, showWelcome, showScrollDown, composer, model, research, onScrollToBottom, onReview, onAbort, onRemoveWorkspaceReference }: ConversationComposerProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useFeedback();
  const openSettings = useUiStore((s) => s.openSettings);
  const { input, setInput, files, setFiles, workspaceReferences } = composer;
  const mcpDiagnostics = useRuntimeStore((state) => state.cwd === workspaceCwd && state.activeSessionId === activeSessionId ? state.mcpDiagnostics : undefined);
  const sendPrompt = useRuntimeStore((state) => state.sendPrompt);
  const [composing, setComposing] = useState(false);
  const quote = composer.quote;
  const clearQuote = useMessageQuoteStore((state) => state.clearQuote);
  // The retry lookup matches the request the server recorded, which carried the
  // quote too. A draft-only digest would miss it after a failed send.
  const composedDraft = quote ? composeQuotedPrompt(quote, input.trim()) : input.trim();
  const retryRequest = activeSessionId && composedDraft
    ? findLocalPromptRequest(workspaceCwd, activeSessionId, promptContentDigest(composedDraft))
    : null;
  const canSend = Boolean(input.trim() || files.length > 0 || workspaceReferences.length > 0 || quote);
  const queuedMessages = useRuntimeStore((state) => (state.queueSessionId === activeSessionId ? state.queuedMessages : NO_QUEUED_MESSAGES));
  const queuePaused = useRuntimeStore((state) => (state.queueSessionId === activeSessionId ? state.queuePaused : false));
  const loadQueue = useRuntimeStore((state) => state.loadQueue);
  const resumeQueue = useRuntimeStore((state) => state.resumeQueue);
  const cancelQueuedMessage = useRuntimeStore((state) => state.cancelQueuedMessage);
  const dispatchQueuedMessage = useRuntimeStore((state) => state.dispatchQueuedMessage);
  const retryQueuedMessage = useRuntimeStore((state) => state.retryQueuedMessage);
  const pendingQueueCount = queuedMessages.filter((entry) => entry.status === "queued" || entry.status === "dispatching").length;

  useEffect(() => {
    if (!activeSessionId) return;
    void loadQueue();
  }, [activeSessionId, working, loadQueue]);

  useEffect(() => {
    // The server dispatches queued messages on its own clock, so the list is
    // authoritative and has to be re-read while something can still move.
    // A paused queue only moves when the user acts, and that path refreshes it.
    if (!activeSessionId || pendingQueueCount === 0 || queuePaused) return;
    const timer = setInterval(() => { void loadQueue(); }, 3000);
    return () => clearInterval(timer);
  }, [activeSessionId, pendingQueueCount, queuePaused, loadQueue]);

  /** Editing means moving the message back into the composer: cancel first, so a
   *  failed cancel leaves the queue and the draft untouched, and never overwrite
   *  text the user is writing — that loss cannot be undone. */
  const editInComposer = async (entry: QueuedMessage) => {
    if (composer.input.trim()) {
      composer.inputRef.current?.focus();
      toast(t("conversation.queue.composerBusy"), "info");
      return;
    }
    try { await cancelQueuedMessage(entry.id); }
    catch { toast(t("conversation.queue.updateFailed"), "error"); return; }
    // The queue only carries plain text, so stale entities would no longer match it.
    composer.setEntities([]);
    setInput(entry.text);
    composer.inputRef.current?.focus();
  };

  return (
    <div className={cn("px-4 sm:px-8 shrink-0", showWelcome ? "py-0" : "pb-1 pt-1")}>
      {!showWelcome && (
        <div className="relative mx-auto max-w-[var(--conversation-composer-width)]">
          {showScrollDown && (
            <button
              type="button"
              aria-label={t("conversation.scrollToLatest")}
              onClick={onScrollToBottom}
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
        <McpDiagnosticsNotice diagnostics={mcpDiagnostics} />
        {promptDeliveryNotice === "indeterminate" && <div role="status" className="mb-2 rounded-input border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-muted">{t("conversation.promptDelivery.indeterminate")}</div>}
        {retryRequest && <button type="button" onClick={() => { void sendPrompt(composedDraft, retryRequest.clientMessageId).catch(() => undefined); }} className="mb-2 text-xs text-accent hover:underline">{t("conversation.promptDelivery.retrySameRequest")}</button>}
        <QueuedMessagesPanel
          entries={queuedMessages}
          paused={queuePaused}
          onResume={resumeQueue}
          onEditInComposer={editInComposer}
          onCancel={cancelQueuedMessage}
          onRetry={retryQueuedMessage}
          onDispatch={dispatchQueuedMessage}
        />
        {/* Fixed 36px fade band above the composer card (reference:
            ConversationRoot composer seat gradient). The card sits at the
            bottom of the column, so the band softens the transcript edge
            scrolling into it. */}
        {!showWelcome && !interactionPending && (
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
          onDragOver={(event) => { event.preventDefault(); composer.setDragOver(true); }}
          onDragLeave={() => composer.setDragOver(false)}
          onDrop={composer.handleDrop}
        >
          {workspaceReferences.length > 0 && (
            <div className="border-b border-faint px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {workspaceReferences.map((reference) => (
                  <span key={reference.path} className="flex max-w-full items-center gap-1 rounded-input bg-accent/5 px-2 py-1 font-mono text-[11px] text-text ring-1 ring-accent/20">
                    <button type="button" className="flex min-w-0 items-center gap-1 text-left" title={`${t("conversation.clickToInsert")} ${reference.path}`} aria-label={`${t("conversation.clickToInsert")} ${reference.path}`} onClick={() => { setInput(input ? `${input} ${reference.path}` : reference.path); composer.inputRef.current?.focus(); }}>
                    {reference.isDir ? <FolderOpen size={11} className="shrink-0 text-accent" /> : <File size={11} className="shrink-0 text-accent" />}
                    <span className="truncate">{reference.path}</span></button>
                    <button type="button" aria-label={t("conversation.removeReference", { name: reference.name })} onClick={(event) => { event.stopPropagation(); onRemoveWorkspaceReference(workspaceCwd, reference.path); }} className="shrink-0 text-muted hover:text-error-text">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {files.map((file, index) => (
                <span key={index} className="flex items-center gap-1 rounded-input bg-surface-2 px-2 py-1 font-mono text-[11px] text-text ring-1 ring-border">
                  {file.name}
                  <button type="button" aria-label={t("conversation.removeAttachment", { name: file.name })} onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} className="text-muted hover:text-error-text">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {quote && <MessageQuoteCard quote={quote} onRemove={() => clearQuote(quote.source)} />}
          {model.modelError && <p role="alert" className="mx-3 my-2 break-words rounded-input border border-error/30 bg-error/5 px-3 py-2 text-ui-body text-error-text">{model.modelError}<button type="button" className="ml-3 underline" onClick={() => openSettings(workspaceCwd, "models")}>{t("settings.models.title")}</button></p>}
          {reviewNotice && <p role="status" className="mx-3 my-2 break-words text-ui-label text-muted">{reviewNotice}</p>}

          <MentionComposer
            cwd={workspaceCwd}
            value={input}
            entities={composer.entities}
            onChange={(value, _mentions, entities) => { setInput(value); composer.setEntities(entities); }}
            onKeyDown={composer.handleKeyDown}
            onCompositionStart={() => { composer.composingRef.current = true; setComposing(true); }}
            onCompositionEnd={() => { setTimeout(() => { composer.composingRef.current = false; setComposing(false); }, 0); }}
            inputRef={composer.inputRef}
            composing={composing}
            composingRef={composer.composingRef}
            placeholder={composer.dragOver ? t("conversation.dropFiles") : research.prompt}
          />
          <div className={cn("flex items-center justify-between gap-2 px-3 pb-2", working && "flex-wrap")}>
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => composer.fileInputRef.current?.click()}
                aria-label={t("conversation.attach")}
                title={t("conversation.attach")}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                <Plus size={15} />
              </button>
              <ApprovalModeMenu cwd={workspaceCwd} sessionId={activeSessionId} disabled={working || interactionPending || reviewingProject} />
              {autoReviewOn ? (
                <button
                  type="button"
                  onClick={() => navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/memory`)}
                  className="flex min-h-7 items-center gap-1 rounded-input border border-ok/40 bg-ok/10 px-2 py-1 text-xs text-ok-text hover:bg-ok/15"
                  title={t("conversation.autoReviewOnTitle")}
                >
                  <Sparkles size={13} />
                  {t("conversation.autoReviewOn")}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={t("conversation.review")}
                  onClick={onReview}
                  disabled={working || interactionPending || reviewingProject}
                  className="flex min-h-7 items-center gap-1 rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text disabled:cursor-wait disabled:opacity-50"
                  title={t("conversation.reviewTitle")}
                >
                  {reviewingProject ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  <span className="composer-review-label">{t("conversation.review")}</span>
                </button>
              )}
            </div>
            <input ref={composer.fileInputRef} type="file" multiple className="hidden" onChange={composer.handleFilePick} />
            {/* The trailing controls give up horizontal space before they leave the
                card: the send/stop buttons hold their size, the model menu truncates
                to a readable floor, and below the sm breakpoint the approval chip and
                the thinking level give up their labels. The row breaks between the
                two clusters, never inside the trailing one, so Stop shares a line
                with the send control instead of dangling on a line of its own. */}
            <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5">
              {model.models.length > 0 && (
                <ModelControlMenu
                  models={model.models}
                  selectedModel={model.selectedModel}
                  needsModelSwitch={model.needsModelSwitch}
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
              {/* One accent slot per state: while a turn is running, a draft
                  turns the slot into queue-send and an empty input keeps it as
                  Stop. The draft keeps a muted 24px stop to its left so the
                  interrupt stays reachable without a second accent. */}
              {working ? (
                canSend ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button type="button" aria-label={t("conversation.stopGeneration")} title={t("conversation.stopGeneration")} onClick={() => void onAbort().catch(() => undefined)} className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:text-error-text">
                      <Square size={14} fill="currentColor" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("conversation.sendToQueue")}
                      title={t("conversation.queueSendHint")}
                      onClick={() => { void composer.handleSend().catch(() => undefined); }}
                      disabled={model.configuringModel || interactionPending || reviewingProject || !model.selectedModel}
                      className={cn(
                        "flex h-[var(--send-button-size)] w-[var(--send-button-size)] shrink-0 items-center justify-center rounded-full",
                        (model.selectedModel && !model.configuringModel && !interactionPending && !reviewingProject) ? "bg-accent-fill text-accent-fg" : "bg-surface-2 text-muted cursor-default",
                      )}
                    >
                      <ArrowUp size={16} />
                    </button>
                  </div>
                ) : (
                  <button type="button" aria-label={t("conversation.stopGeneration")} title={t("conversation.stopGeneration")} onClick={() => void onAbort().catch(() => undefined)} className="flex h-[var(--send-button-size)] w-[var(--send-button-size)] shrink-0 items-center justify-center rounded-full bg-accent-fill text-accent-fg transition-colors hover:bg-error-fill">
                    <Square size={14} fill="currentColor" />
                  </button>
                )
              ) : (
                <button
                  type="button"
                  aria-label={t("conversation.sendMessage")}
                  onClick={() => { void composer.handleSend().catch(() => undefined); }}
                  disabled={working || model.configuringModel || interactionPending || !model.selectedModel || reviewingProject || (!activeSessionId && status === "connecting") || !canSend}
                  className={cn(
                    "flex h-[var(--send-button-size)] w-[var(--send-button-size)] shrink-0 items-center justify-center rounded-full",
                    (model.selectedModel && !model.configuringModel && !interactionPending && !reviewingProject && (activeSessionId || status !== "connecting") && canSend) ? "bg-accent-fill text-accent-fg" : "bg-surface-2 text-muted cursor-default",
                  )}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
        {!showWelcome && <ConversationStatsLine stats={sessionStats} />}
      </div>
    </div>
  );
}
