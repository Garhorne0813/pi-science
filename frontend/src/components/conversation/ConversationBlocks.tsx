import { useState } from "react";
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
import { MessageActions, type MessageBookmarkAction } from "./MessageActions";

/** Render blocks, grouping consecutive tool cards together. */
export function groupBlocks(blocks: ThreadBlock[]): ThreadBlock[][] {
  // Defensive: a transient store state (e.g. mid-recovery) must never crash
  // the whole conversation render with "blocks is not iterable".
  if (!Array.isArray(blocks)) return [];
  const groups: ThreadBlock[][] = [];
  let toolGroup: ToolCallBlock[] = [];
  const flushTools = () => {
    if (toolGroup.length > 0) groups.push(toolGroup);
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

export function renderBlockGroup(blocks: ThreadBlock[], codeRunner: CodeRunner, actionTextByBlock?: Map<string, string>, bookmarkActions?: Map<string, MessageBookmarkAction>) {
  const result: React.ReactNode[] = [];
  // Compute the copy-button map across the WHOLE thread once (see
  // renderBlocks): the guard inside agentActionTextByBlock needs the blocks
  // that follow the agent block (e.g. tool calls) to decide whether this is
  // the final answer. A per-group computation never sees the trailing tools,
  // so every agent block would wrongly get a copy button.
  const effectiveActionText = actionTextByBlock ?? agentActionTextByBlock(blocks);
  if (blocks.every((block): block is ToolCallBlock => block.kind === "tool")) {
    if (blocks.length > 1) result.push(<ToolGroup key={blocks[0].id} blocks={blocks} />);
    else if (blocks[0]) result.push(<ToolCard key={blocks[0].id} block={blocks[0]} />);
    return result;
  }
  for (const block of blocks) {
    result.push(<BlockRenderer key={block.id} block={block} actionText={effectiveActionText.get(block.id)} bookmark={bookmarkActions?.get(block.id)} codeRunner={codeRunner} />);
  }
  return result;
}

export function renderBlocks(blocks: ThreadBlock[], codeRunner: CodeRunner, bookmarkActions?: Map<string, MessageBookmarkAction>) {
  if (!Array.isArray(blocks)) return null;
  const actionTextByBlock = agentActionTextByBlock(blocks);
  return groupBlocks(blocks).flatMap((group) => renderBlockGroup(group, codeRunner, actionTextByBlock, bookmarkActions));
}

/* ── Block Renderers ── */

function BlockRenderer({ block, actionText, bookmark, codeRunner }: { block: ThreadBlock; actionText?: string; bookmark?: MessageBookmarkAction; codeRunner: CodeRunner }) {
  switch (block.kind) {
    case "user": return <UserMessage id={block.id} text={block.text} timestamp={block.timestamp} bookmark={bookmark} />;
    case "agent": return <AgentMessage id={block.id} parts={block.parts} partial={block.partial} timestamp={block.timestamp} actionText={actionText} bookmark={bookmark} codeRunner={codeRunner} />;
    case "tool": return <ToolCard block={block} />;
    case "status-line": return <StatusLine block={block} />;
    case "artifact-summary": return <TurnArtifactStrip artifacts={block.artifacts} cwd={codeRunner?.cwd} />;
    default: return null;
  }
}

/** Group consecutive tool blocks into one stable-height summary. */
function ToolGroup({ blocks }: { blocks: ToolCallBlock[] }) {
  const [expanded, setExpanded] = useState(false);
  if (blocks.length <= 1) return <ToolCard block={blocks[0]} />;

  const allDone = blocks.every((block) => block.status === "done" || block.status === "error");
  const doneCount = blocks.filter((block) => block.status === "done").length;
  const tools = [...new Set(blocks.map((block) => block.tool))].join(", ");
  return (
    <div className="ui-card-flat animate-fadeIn overflow-hidden rounded-input">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-[12.5px] text-muted hover:bg-surface-2"
      >
        <span className="text-xs">{expanded ? "▼" : "▶"}</span>
        <span>{tools}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px]">
          {!allDone && <Loader2 size={11} className="animate-spin text-accent" />}
          {doneCount}/{blocks.length} done
        </span>
      </button>
      {expanded && (
        <div className="border-t border-faint">
          {blocks.map((b) => <ToolCard key={b.id} block={b} />)}
        </div>
      )}
    </div>
  );
}

function UserMessage({ id, text, timestamp, bookmark }: { id: string; text: string; timestamp?: string; bookmark?: MessageBookmarkAction }) {
  const visibleText = visibleUserMessage(text);
  const references = referencesFromMessage(text);
  const copyText = visibleText || references.map((reference) => reference.path).join("\n");
  return (
    <div id={`user-msg-${id}`} className="group/message ml-auto flex max-w-[85%] scroll-mt-4 flex-col items-end gap-1">
      {visibleText && (
        <div className="ui-user-message rounded-card px-3 py-2 text-sm leading-relaxed text-text whitespace-pre-wrap">
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
      <MessageActions text={copyText} timestamp={timestamp} align="right" bookmark={bookmark} />
    </div>
  );
}

function AgentMessage({ id, parts, partial, timestamp, actionText, bookmark, codeRunner }: { id: string; parts: { id: string; text: string }[]; partial?: boolean; timestamp?: string; actionText?: string; bookmark?: MessageBookmarkAction; codeRunner?: CodeRunner }) {
  const { t } = useTranslation();
  const rawText = parts.map((p) => p.text).join("");
  if (!rawText && partial) return null;
  if (!rawText) return null;

  const text = parseSuggestions(rawText).clean;
  const citations = extractCitations(text);

  return (
    <div id={`agent-msg-${id}`} className="group/message scroll-mt-4">
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
      {(actionText || bookmark) && <MessageActions text={actionText ? parseSuggestions(actionText).clean : ""} timestamp={timestamp} bookmark={bookmark} />}
    </div>
  );
}

function shortCitationId(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 14)}…${id.slice(-8)}`;
}

function ToolCard({ block }: { block: ToolCallBlock }) {
  const [expanded, setExpanded] = useState(false);
  const tool = block.tool;
  const status = block.status;
  const output = block.output || block.partialOutput;

  const statusIcon = status === "running" ? (
    <Loader2 size={13} className="animate-spin text-accent" />
  ) : status === "error" ? (
    <span className="text-error text-xs">✕</span>
  ) : status === "done" ? (
    <span className="text-ok text-xs">✓</span>
  ) : (
    <span className="text-muted text-xs">○</span>
  );

  return (
    <div className={cn(
      "rounded-input px-3 py-2",
      status === "error" ? "border border-error/30 bg-error/5" : "ui-card-inset",
    )}>
      <button
        onClick={() => output && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left text-[12.5px] text-muted"
      >
        {statusIcon}
        <span className="font-mono text-xs">{tool}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider">{status}</span>
      </button>
      {expanded && output && (
        <pre className="mt-2 whitespace-pre-wrap break-all rounded-input bg-surface-2 px-3 py-2 font-mono text-xs leading-5 text-text max-h-48 overflow-y-auto">
          {output.slice(0, 8000)}
        </pre>
      )}
    </div>
  );
}

function StatusLine({ block }: { block: { kind: "status-line"; text: string; level: string; artifactId?: string; path?: string } }) {
  const openInspector = useUiStore((s) => s.openInspector);
  const cwd = useRuntimeStore((s) => s.cwd);
  const tone = block.level === "error" ? "text-error" : block.level === "done" ? "text-ok" : "text-muted";
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
