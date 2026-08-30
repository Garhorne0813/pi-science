import { useTranslation } from "react-i18next";
import { Loader2, File, FolderOpen } from "lucide-react";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import type { AgentMessageBlock, StatusLineBlock, ThreadBlock, UserMessageBlock } from "../../types/thread";
import { MarkdownViewer, type CodeRunner } from "../markdown-viewer/MarkdownViewer";
import { fileInspectorFromBlock, refToArtifactBlock } from "../../lib/artifacts";
import { TurnArtifactStrip } from "./TurnArtifactStrip";
import { referencesFromMessage, visibleUserMessage } from "../../lib/files";
import { agentActionTextByBlock } from "../../lib/conversation";
import { extractCitations } from "../../lib/citations";
import { parseSuggestions } from "../../lib/conversation";
import { MessageActions } from "./MessageActions";
import { buildTurnPresentations, turnBlockIds, type TurnPresentation } from "../../lib/conversation/turn-presentation";
import { AgentActivity } from "./AgentActivity";
import { ProgressVisual, useProgressAppearance } from "../progress/ProgressVisual";

export function renderTurn(turn: TurnPresentation, codeRunner: CodeRunner, actionTextByBlock?: Map<string, string>) {
  return <ConversationTurn key={turn.id} turn={turn} codeRunner={codeRunner} actionTextByBlock={actionTextByBlock} />;
}

export function renderBlocks(blocks: ThreadBlock[], codeRunner: CodeRunner) {
  if (!Array.isArray(blocks)) return null;
  const actionTextByBlock = agentActionTextByBlock(blocks);
  return buildTurnPresentations(blocks).map((turn) => renderTurn(turn, codeRunner, actionTextByBlock));
}

function ConversationTurn({ turn, codeRunner, actionTextByBlock }: { turn: TurnPresentation; codeRunner: CodeRunner; actionTextByBlock?: Map<string, string> }) {
  const visibleAgent = turn.finalAgent ?? turn.provisionalAgent;
  return (
    <div data-thread-block-ids={turnBlockIds(turn).join(" ")} className="flex flex-col gap-3 scroll-mt-4">
      {turn.user && <UserMessage block={turn.user} />}
      {turn.activityTools.length > 0 || (turn.active && (turn.lifecycle === "waiting" || turn.lifecycle === "recovering")) ? <AgentActivity blocks={turn.activityTools} lifecycle={turn.lifecycle} /> : null}
      {visibleAgent && <AgentMessage block={visibleAgent} actionText={turn.finalAgent ? actionTextByBlock?.get(turn.finalAgent.id) : undefined} codeRunner={codeRunner} />}
      {turn.systemBlocks.map((block) => <SystemBlock key={block.id} block={block} />)}
      {turn.artifacts.map((block) => <TurnArtifactStrip key={block.id} artifacts={block.artifacts} cwd={codeRunner?.cwd} />)}
    </div>
  );
}

function UserMessage({ block }: { block: UserMessageBlock }) {
  const visibleText = visibleUserMessage(block.text);
  const references = referencesFromMessage(block.text);
  const copyText = visibleText || references.map((reference) => reference.path).join("\n");
  return (
    <div id={`user-msg-${block.id}`} className="group/message ml-auto flex max-w-[min(var(--user-message-width),82%)] scroll-mt-4 flex-col items-end gap-1">
      {visibleText && <div className="ui-user-message rounded-bubble px-4 py-2.5 text-sm leading-relaxed text-text whitespace-pre-wrap">{visibleText}</div>}
      {references.length > 0 && <div className="flex flex-wrap justify-end gap-1.5" aria-label="Referenced context">
        {references.map((reference) => <span key={`${reference.isDir ? "folder" : "file"}-${reference.path}`} className="flex max-w-full items-center gap-1 rounded-input border border-accent/20 bg-accent/5 px-2 py-1 font-mono text-[10px] text-muted" title={reference.path}>
          {reference.isDir ? <FolderOpen size={10} /> : <File size={10} />}
          <span className="truncate">{reference.path}</span>
        </span>)}
      </div>}
      <MessageActions text={copyText} timestamp={block.timestamp} align="right" />
    </div>
  );
}

function AgentMessage({ block, actionText, codeRunner }: { block: AgentMessageBlock; actionText?: string; codeRunner?: CodeRunner }) {
  const { t } = useTranslation();
  const progressAppearance = useProgressAppearance();
  const rawText = block.parts.map((part) => part.text).join("");
  if (!rawText) return null;
  const text = parseSuggestions(rawText).clean;
  const citations = extractCitations(text);
  return <div className="group/message">
    {block.partial && <div className="mb-1 flex h-5 items-center gap-2" role="status"><span aria-hidden><ProgressVisual slot="streamingAnswer" config={progressAppearance} text="AI" compact /></span><span className="text-xs text-muted">{t("conversation.activity.streaming")}</span></div>}
    <MarkdownViewer variant="chat" codeRunner={codeRunner}>{text}</MarkdownViewer>
    {citations.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-muted">{t("conversation.sources")} ({citations.length})</span>
      {citations.map((citation, index) => <a key={`${citation.kind}:${citation.id}`} href={citation.url} target="_blank" rel="noreferrer" title={citation.id} className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted hover:text-text">{index + 1} · {shortCitationId(citation.id)}</a>)}
    </div>}
    {!block.partial && actionText && <MessageActions text={parseSuggestions(actionText).clean} timestamp={block.timestamp} />}
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
