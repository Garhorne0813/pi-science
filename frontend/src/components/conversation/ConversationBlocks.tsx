import { useTranslation } from "react-i18next";
import { Loader2, File, FolderOpen } from "lucide-react";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { MarkdownViewer, type CodeRunner } from "../markdown-viewer/MarkdownViewer";
import { fileInspectorFromBlock, refToArtifactBlock } from "../../lib/artifacts";
import { TurnArtifactStrip } from "./TurnArtifactStrip";
import { referencesFromMessage, visibleUserMessage } from "../../lib/files";
import { agentActionTextByBlock } from "../../lib/conversation";
import { extractCitations } from "../../lib/citations";
import { parseSuggestions } from "../../lib/conversation";
import { MessageActions } from "./MessageActions";
import { isVisibleActivity } from "../../lib/conversation/activity-policy";
import { AgentActivity } from "./AgentActivity";

/** Group consecutive tool events into one activity trace. */
export function groupBlocks(blocks: ThreadBlock[]): ThreadBlock[][] {
  // Defensive: a transient store state (e.g. mid-recovery) must never crash
  // the whole conversation render with "blocks is not iterable".
  if (!Array.isArray(blocks)) return [];
  const groups: ThreadBlock[][] = [];
  let toolGroup: ToolCallBlock[] = [];
  const flushTools = () => {
    if (toolGroup.some(isVisibleActivity)) groups.push(toolGroup);
    toolGroup = [];
  };
  for (const block of blocks) {
    if (block.kind === "tool") toolGroup.push(block);
    else {
      flushTools();
      groups.push([block]);
    }
  }
  flushTools();
  return groups;
}

export function renderBlockGroup(blocks: ThreadBlock[], codeRunner: CodeRunner, actionTextByBlock?: Map<string, string>) {
  const result: React.ReactNode[] = [];
  // Compute the copy-button map across the WHOLE thread once (see
  // renderBlocks): the guard inside agentActionTextByBlock needs the blocks
  // that follow the agent block (e.g. tool calls) to decide whether this is
  // the final answer. A per-group computation never sees the trailing tools,
  // so every agent block would wrongly get a copy button.
  const effectiveActionText = actionTextByBlock ?? agentActionTextByBlock(blocks);
  if (blocks.every((block): block is ToolCallBlock => block.kind === "tool")) {
    if (blocks[0]) result.push(<AgentActivity key={blocks[0].id} blocks={blocks} />);
    return result;
  }
  for (const block of blocks) {
    result.push(<BlockRenderer key={block.id} block={block} actionText={effectiveActionText.get(block.id)} codeRunner={codeRunner} />);
  }
  return result;
}

export function renderBlocks(blocks: ThreadBlock[], codeRunner: CodeRunner) {
  if (!Array.isArray(blocks)) return null;
  const actionTextByBlock = agentActionTextByBlock(blocks);
  return groupBlocks(blocks).flatMap((group) => renderBlockGroup(group, codeRunner, actionTextByBlock));
}

/* ── Block Renderers ── */

function BlockRenderer({ block, actionText, codeRunner }: { block: ThreadBlock; actionText?: string; codeRunner: CodeRunner }) {
  switch (block.kind) {
    case "user": return <UserMessage id={block.id} text={block.text} timestamp={block.timestamp} />;
    case "agent": return <AgentMessage parts={block.parts} partial={block.partial} timestamp={block.timestamp} actionText={actionText} codeRunner={codeRunner} />;
    case "tool": return <AgentActivity blocks={[block]} />;
    case "status-line": return <StatusLine block={block} />;
    case "artifact-summary": return <TurnArtifactStrip artifacts={block.artifacts} cwd={codeRunner?.cwd} />;
    default: return null;
  }
}

function UserMessage({ id, text, timestamp }: { id: string; text: string; timestamp?: string }) {
  const visibleText = visibleUserMessage(text);
  const references = referencesFromMessage(text);
  const copyText = visibleText || references.map((reference) => reference.path).join("\n");
  return (
    <div id={`user-msg-${id}`} className="group/message ml-auto flex max-w-[min(var(--user-message-width),82%)] scroll-mt-4 flex-col items-end gap-1">
      {visibleText && (
        <div className="ui-user-message rounded-bubble px-4 py-2.5 text-sm leading-relaxed text-text whitespace-pre-wrap">
          {visibleText}
        </div>
      )}
      {references.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5" aria-label="Referenced context">
          {references.map((reference) => (
            <span key={`${reference.isDir ? "folder" : "file"}-${reference.path}`} className="flex max-w-full items-center gap-1 rounded-input border border-accent/20 bg-accent/5 px-2 py-1 font-mono text-[10px] text-muted" title={reference.path}>
              {reference.isDir ? <FolderOpen size={10} /> : <File size={10} />}
              <span className="truncate">{reference.path}</span>
            </span>
          ))}
        </div>
      )}
      <MessageActions text={copyText} timestamp={timestamp} align="right" />
    </div>
  );
}

function AgentMessage({ parts, partial, timestamp, actionText, codeRunner }: { parts: { id: string; text: string }[]; partial?: boolean; timestamp?: string; actionText?: string; codeRunner?: CodeRunner }) {
  const { t } = useTranslation();
  const rawText = parts.map((p) => p.text).join("");
  if (!rawText && partial) return null;
  if (!rawText) return null;

  const text = parseSuggestions(rawText).clean;
  const citations = extractCitations(text);

  return (
    <div className="group/message">
      <MarkdownViewer variant="chat" codeRunner={codeRunner}>{text}</MarkdownViewer>
      {citations.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-muted">{t("conversation.sources")} ({citations.length})</span>
          {citations.map((citation, index) => (
            <a
              key={`${citation.kind}:${citation.id}`}
              href={citation.url}
              target="_blank"
              rel="noreferrer"
              title={citation.id}
              className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted hover:text-text"
            >
              {index + 1} · {shortCitationId(citation.id)}
            </a>
          ))}
        </div>
      )}
      {actionText && <MessageActions text={parseSuggestions(actionText).clean} timestamp={timestamp} />}
    </div>
  );
}

function shortCitationId(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 14)}…${id.slice(-8)}`;
}

function StatusLine({ block }: { block: { kind: "status-line"; text: string; level: string; artifactId?: string; path?: string } }) {
  const openInspector = useUiStore((s) => s.openInspector);
  const cwd = useRuntimeStore((s) => s.cwd);
  const tone = block.level === "error" ? "text-error-text" : block.level === "done" ? "text-ok-text" : "text-muted";
  if (block.path) {
    const artifact = refToArtifactBlock(block.path);
    return (
      <button type="button" onClick={() => openInspector({ ...fileInspectorFromBlock(artifact as any), cwd } as any)} className={cn("flex items-center gap-2 text-xs hover:underline", tone)}>
        {block.text}
      </button>
    );
  }
  return (
    <div className={cn("flex items-center gap-2 text-xs", tone)}>
      {block.level === "running" && <Loader2 size={14} className="animate-spin text-accent" />}
      {block.text}
    </div>
  );
}
