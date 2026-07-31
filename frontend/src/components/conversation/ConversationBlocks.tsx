import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, File, FolderOpen } from "lucide-react";
import { cn } from "../../lib/cn";
import { useUiStore } from "../../lib/store";
import { useRuntimeStore } from "../../lib/runtime-store";
import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { MarkdownViewer, type CodeRunner } from "../markdown-viewer/MarkdownViewer";
import { extractArtifactRefs, refToArtifactBlock, fileInspectorFromBlock } from "../../lib/artifacts";
import { referencesFromMessage, visibleUserMessage } from "../../lib/file-references";
import { agentActionTextByBlock } from "../../lib/message-actions";
import { extractCitations } from "../../lib/citations";
import { parseSuggestions } from "../../lib/suggestions";
import { MessageActions } from "./MessageActions";

/** Render blocks, grouping consecutive tool cards together. */
export function renderBlocks(blocks: ThreadBlock[], codeRunner: CodeRunner) {
  const result: React.ReactNode[] = [];
  let toolGroup: ToolCallBlock[] = [];
  const actionTextByBlock = agentActionTextByBlock(blocks);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "tool") {
      toolGroup.push(block);
    } else {
      if (toolGroup.length > 0) {
        result.push(<ToolGroup key={toolGroup[0].id} blocks={toolGroup} />);
        toolGroup = [];
      }
      result.push(<BlockRenderer key={block.id} block={block} actionText={actionTextByBlock.get(block.id)} codeRunner={codeRunner} />);
    }
  }
  if (toolGroup.length > 0) {
    result.push(<ToolGroup key={toolGroup[0].id} blocks={toolGroup} />);
  }
  return result;
}

/* ── Block Renderers ── */

function BlockRenderer({ block, actionText, codeRunner }: { block: ThreadBlock; actionText?: string; codeRunner: CodeRunner }) {
  switch (block.kind) {
    case "user": return <UserMessage id={block.id} text={block.text} timestamp={block.timestamp} />;
    case "agent": return <AgentMessage parts={block.parts} partial={block.partial} timestamp={block.timestamp} actionText={actionText} codeRunner={codeRunner} />;
    case "tool": return <ToolCard block={block} />;
    case "status-line": return <StatusLine block={block} />;
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
    <div className="rounded-input border border-border bg-surface overflow-hidden animate-fadeIn">
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

function UserMessage({ id, text, timestamp }: { id: string; text: string; timestamp?: string }) {
  const visibleText = visibleUserMessage(text);
  const references = referencesFromMessage(text);
  const copyText = visibleText || references.map((reference) => reference.path).join("\n");
  return (
    <div id={`user-msg-${id}`} className="group/message ml-auto flex max-w-[85%] scroll-mt-4 flex-col items-end gap-1.5">
      {visibleText && (
        <div className="rounded-card bg-surface-2 px-4 py-3 text-[15px] leading-relaxed text-text whitespace-pre-wrap">
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
  const openInspector = useUiStore((s) => s.openInspector);
  if (!rawText && partial) return null;
  if (!rawText) return null;

  const text = parseSuggestions(rawText).clean;
  // Detect file references and make them clickable
  const refs = extractArtifactRefs(text);
  const citations = extractCitations(text);

  const handleFileClick = (filePath: string) => {
    const block = refToArtifactBlock(filePath);
    const inspector = fileInspectorFromBlock(block as any);
    openInspector(inspector as any);
  };

  return (
    <div className="group/message">
      <MarkdownViewer variant="chat" codeRunner={codeRunner}>{text}</MarkdownViewer>
      {refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {refs.map((ref) => (
            <button
              key={ref}
              onClick={() => handleFileClick(ref)}
              className="rounded-input border border-border bg-surface px-2 py-1 font-mono text-[11px] text-link hover:bg-surface-2"
            >
              📄 {ref}
            </button>
          ))}
        </div>
      )}
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
      "rounded-input border px-3 py-2",
      status === "error" ? "border-error/30 bg-error/5" : "border-border bg-surface",
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
