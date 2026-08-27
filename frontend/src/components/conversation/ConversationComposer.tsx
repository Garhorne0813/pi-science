import { lazy, Suspense, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, File, FolderOpen, Loader2, Plus, Sparkles, Square, X } from "lucide-react";
import type { SessionStats } from "../../lib/client/pi-science-client";
import type { useComposer } from "../../hooks/useComposer";
import type { useModelConfig } from "../../hooks/useModelConfig";
import type { useResearchLoop } from "../../hooks/useResearchLoop";
import { ConversationStatsLine } from "./ConversationStatsLine";
import { MentionComposer } from "./MentionComposer";
import { ModelControlMenu } from "./ModelControlMenu";
import { cn } from "../../lib/ui";
import { SlashCommandMenu } from "../SlashCommandMenu";

const ComposerTodo = lazy(() => import("../todo/ComposerTodo").then((module) => ({ default: module.ComposerTodo })));

type ComposerState = ReturnType<typeof useComposer>;
type ModelState = ReturnType<typeof useModelConfig>;
type ResearchState = ReturnType<typeof useResearchLoop>;

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
  modePicker: ReactNode;
  onScrollToBottom: () => void;
  onReview: () => void;
  onAbort: () => Promise<unknown>;
  onRemoveWorkspaceReference: (cwd: string, path: string) => void;
}

/** The composer seat is kept separate from the route so streamed transcript
 * updates do not make the page's orchestration code own every control detail. */
export function ConversationComposer({ workspaceCwd, status, activeSessionId, sessionStats, contextTokens, contextWindow, contextPercent, compactionEnabled, compactionThresholdPercent, working, interactionPending, reviewingProject, reviewNotice, autoReviewOn, modelControlsDisabled, showWelcome, showScrollDown, composer, model, research, modePicker, onScrollToBottom, onReview, onAbort, onRemoveWorkspaceReference }: ConversationComposerProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { input, setInput, files, setFiles, workspaceReferences } = composer;
  return (
    <div className={cn("px-8 shrink-0", showWelcome ? "py-0" : "pb-1 pt-1")}>
      {!showWelcome && (
        <div className="relative mx-auto max-w-[var(--conversation-composer-width)]">
          {modePicker}
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
        {/* Fixed 36px fade band above the composer card (reference:
            ConversationRoot composer seat gradient). The card sits at the
            bottom of the column, so the band softens the transcript edge
            scrolling into it. */}
        {!modePicker && (
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
                  <span key={reference.path} className="flex max-w-full items-center gap-1 rounded-input bg-accent/5 px-2 py-1 font-mono text-[11px] text-text ring-1 ring-accent/20 cursor-pointer hover:bg-accent/10" title={`${t("conversation.clickToInsert")} ${reference.path}`} onClick={() => { const current = input; setInput(current ? `${current} ${reference.path}` : reference.path); }}>
                    {reference.isDir ? <FolderOpen size={11} className="shrink-0 text-accent" /> : <File size={11} className="shrink-0 text-accent" />}
                    <span className="truncate">{reference.path}</span>
                    <button type="button" aria-label={`Remove reference ${reference.name}`} onClick={(event) => { event.stopPropagation(); onRemoveWorkspaceReference(workspaceCwd, reference.path); }} className="shrink-0 text-muted hover:text-error-text">
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
                  <button type="button" onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} className="text-muted hover:text-error-text">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <SlashCommandMenu input={input} onSelect={setInput} />
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
                type="button"
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
                  onClick={onReview}
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
                <button type="button" aria-label="Stop generation" onClick={() => void onAbort().catch(() => undefined)} className="flex h-[var(--send-button-size)] w-[var(--send-button-size)] items-center justify-center rounded-full bg-accent-fill text-accent-fg transition-colors hover:bg-error-fill">
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
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
        {!showWelcome && <ConversationStatsLine stats={sessionStats} />}
      </div>
    </div>
  );
}
