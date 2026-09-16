import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, File, FolderOpen, X } from "lucide-react";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import type { AgentMessageBlock, StatusLineBlock, ThreadBlock, UserMessageBlock } from "../../types/thread";
import { MarkdownViewer, type CodeRunner } from "../markdown-viewer/MarkdownViewer";
import { fileInspectorFromBlock, refToArtifactBlock } from "../../lib/artifacts";
import { ReferencedArtifactStrip, TurnArtifactStrip } from "./TurnArtifactStrip";
import { referencesFromMessage, replaceVisibleUserMessage, visibleUserMessage } from "../../lib/files";
import { agentActionTextByBlock } from "../../lib/conversation";
import { extractCitations } from "../../lib/citations";
import { parseSuggestions } from "../../lib/conversation";
import { MessageActions } from "./MessageActions";
import { buildTurnPresentations, turnBlockIds, type TurnPresentation } from "../../lib/conversation/turn-presentation";
import { AgentActivity } from "./AgentActivity";
import { isLiveLifecycle } from "../../lib/conversation/turn-presentation";

export interface UserMessageActionHandlers {
  disabled?: boolean;
  onResend: (block: UserMessageBlock, message: string) => Promise<void>;
}

export interface AgentMessageVersionControls {
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}

export function renderTurn(turn: TurnPresentation, codeRunner: CodeRunner, actionTextByBlock?: Map<string, string>, userActions?: UserMessageActionHandlers, version?: AgentMessageVersionControls) {
  return <ConversationTurn key={turn.id} turn={turn} codeRunner={codeRunner} actionTextByBlock={actionTextByBlock} userActions={userActions} version={version} />;
}

export function renderBlocks(blocks: ThreadBlock[], codeRunner: CodeRunner) {
  if (!Array.isArray(blocks)) return null;
  const actionTextByBlock = agentActionTextByBlock(blocks);
  return buildTurnPresentations(blocks).map((turn) => renderTurn(turn, codeRunner, actionTextByBlock));
}

function ConversationTurn({ turn, codeRunner, actionTextByBlock, userActions, version }: { turn: TurnPresentation; codeRunner: CodeRunner; actionTextByBlock?: Map<string, string>; userActions?: UserMessageActionHandlers; version?: AgentMessageVersionControls }) {
  const visibleAgent = turn.finalAgent ?? turn.provisionalAgent;
  const finalText = turn.finalAgent?.parts.map((part) => part.text).join("") ?? "";
  const publishedPaths = turn.artifacts.flatMap((block) => block.artifacts.map((item) => item.path));
  return (
    <div data-thread-block-ids={turnBlockIds(turn).join(" ")} className="flex flex-col gap-0 scroll-mt-4">
      {turn.user && <UserMessage block={turn.user} actions={userActions} />}
      {(turn.active || turn.activityBlocks.length > 0) && <AgentActivity blocks={turn.activityBlocks} lifecycle={turn.lifecycle} cwd={codeRunner?.cwd} hasFinalAnswer={Boolean(turn.finalAgent)} part={isLiveLifecycle(turn.lifecycle) ? "content" : "both"} />}
      {visibleAgent && <AgentMessage block={visibleAgent} actionText={turn.finalAgent ? actionTextByBlock?.get(turn.finalAgent.id) : undefined} codeRunner={codeRunner} version={turn.finalAgent ? version : undefined} />}
      {(turn.active || turn.activityBlocks.length > 0) && isLiveLifecycle(turn.lifecycle) && <AgentActivity blocks={turn.activityBlocks} lifecycle={turn.lifecycle} cwd={codeRunner?.cwd} hasFinalAnswer={Boolean(turn.finalAgent)} part="status" />}
      {turn.systemBlocks.map((block) => <SystemBlock key={block.id} block={block} />)}
      {turn.artifacts.map((block) => <TurnArtifactStrip key={block.id} artifacts={block.artifacts} cwd={codeRunner?.cwd} />)}
      {finalText && <ReferencedArtifactStrip text={finalText} cwd={codeRunner?.cwd} exclude={publishedPaths} />}
    </div>
  );
}

function UserMessage({ block, actions }: { block: UserMessageBlock; actions?: UserMessageActionHandlers }) {
  const { t } = useTranslation();
  const visibleText = visibleUserMessage(block.text);
  const references = referencesFromMessage(block.text);
  const copyText = visibleText || references.map((reference) => reference.path).join("\n");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(visibleText);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (message: string) => {
    if (!actions || actions.disabled || !message.trim() || submitting) return;
    setSubmitting(true);
    try {
      await actions.onResend(block, message);
      setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div id={`user-msg-${block.id}`} className="group/message ml-auto flex max-w-[min(var(--user-message-width),82%)] scroll-mt-4 flex-col items-end gap-1">
      {block.images && block.images.length > 0 && <div className="flex max-w-full flex-wrap justify-end gap-2" aria-label={t("conversation.attachedImages")}>
        {block.images.map((image, index) => <img key={`${image.mimeType}-${index}`} src={`data:${image.mimeType};base64,${image.data}`} alt={`Attachment ${index + 1}`} className="max-h-64 max-w-full rounded-input border border-border object-contain" />)}
      </div>}
      {editing ? (
        <div className="ui-user-message flex w-[min(32rem,80vw)] flex-col gap-2 rounded-bubble p-2">
          <textarea
            autoFocus
            disabled={actions?.disabled || submitting}
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
              if (event.key === "Enter" && !event.shiftKey && !(event.nativeEvent as KeyboardEvent).isComposing) {
                event.preventDefault();
                void submit(replaceVisibleUserMessage(block.text, editText)).catch(() => undefined);
              }
            }}
            className="min-h-20 resize-y rounded-input bg-transparent px-2 py-1.5 text-sm leading-relaxed text-text outline-none"
            aria-label={t("conversation.edit")}
          />
          <div className="flex justify-end gap-1">
            <button type="button" disabled={submitting} onClick={() => setEditing(false)} className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40" aria-label={t("conversation.cancelEdit")} title={t("conversation.cancelEdit")}><X size={13} /></button>
            <button type="button" disabled={actions?.disabled || submitting || !editText.trim()} onClick={() => void submit(replaceVisibleUserMessage(block.text, editText)).catch(() => undefined)} className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white disabled:opacity-40" aria-label={t("conversation.sendEdit")} title={t("conversation.sendEdit")}><Check size={13} /></button>
          </div>
        </div>
      ) : visibleText ? <div className="ui-user-message rounded-bubble px-4 py-2.5 text-sm leading-relaxed text-text whitespace-pre-wrap">{visibleText}</div> : null}
      {references.length > 0 && <div className="flex flex-wrap justify-end gap-1.5" aria-label={t("conversation.referencedContext")}>
        {references.map((reference) => <span key={`${reference.isDir ? "folder" : "file"}-${reference.path}`} className="flex max-w-full items-center gap-1 rounded-input border border-accent/20 bg-accent/5 px-2 py-1 font-mono text-[10px] text-muted" title={reference.path}>
          {reference.isDir ? <FolderOpen size={10} /> : <File size={10} />}
          <span className="truncate">{reference.path}</span>
        </span>)}
      </div>}
      {!editing && <MessageActions
        text={copyText}
        timestamp={block.timestamp}
        align="right"
        disabled={actions?.disabled || submitting}
        onEdit={actions ? () => { setEditText(visibleText); setEditing(true); } : undefined}
        onRegenerate={actions ? () => void submit(block.text).catch(() => undefined) : undefined}
      />}
    </div>
  );
}

function AgentMessage({ block, actionText, codeRunner, version }: { block: AgentMessageBlock; actionText?: string; codeRunner?: CodeRunner; version?: AgentMessageVersionControls }) {
  const { t } = useTranslation();
  const rawText = block.parts.map((part) => part.text).join("");
  if (!rawText) return null;
  const text = parseSuggestions(rawText).clean;
  const citations = extractCitations(text);
  return <div className="group/message">
    <MarkdownViewer variant="chat" codeRunner={codeRunner}>{text}</MarkdownViewer>
    {citations.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-muted">{t("conversation.sources")} ({citations.length})</span>
      {citations.map((citation, index) => <a key={`${citation.kind}:${citation.id}`} href={citation.url} target="_blank" rel="noreferrer" title={citation.id} className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted hover:text-text">{index + 1} · {shortCitationId(citation.id)}</a>)}
    </div>}
    {!block.partial && actionText && <MessageActions text={parseSuggestions(actionText).clean} timestamp={block.timestamp} version={version} />}
  </div>;
}

function SystemBlock({ block }: { block: ThreadBlock }) {
  if (block.kind === "status-line") return block.level === "error" || block.path ? <StatusLine block={block} /> : null;
  return null;
}

function shortCitationId(id: string): string { return id.length <= 24 ? id : `${id.slice(0, 14)}…${id.slice(-8)}`; }

function StatusLine({ block }: { block: StatusLineBlock }) {
  const openInspector = useUiStore((state) => state.openInspector);
  const cwd = useRuntimeStore((state) => state.cwd);
  const tone = block.level === "error" ? "text-error-text" : block.level === "done" ? "text-ok-text" : "text-muted";
  if (block.path) {
    const artifact = refToArtifactBlock(block.path);
    return <button type="button" onClick={() => openInspector({ ...fileInspectorFromBlock(artifact as any), cwd } as any)} className={cn("flex items-center gap-2 text-xs hover:underline", tone)}>{block.text}</button>;
  }
  return <div className={cn("flex items-center gap-2 text-xs", tone)}>{block.level === "info" && <Loader2 size={14} className="animate-spin text-accent" />}{block.text}</div>;
}
