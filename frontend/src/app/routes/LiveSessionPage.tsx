import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowUp, Loader2, Square, Paperclip, Sparkles, X } from "lucide-react";
import { getSessionName, setSessionName, type AvailableModel } from "../../lib/pi-science-client";
import { useRuntimeStore, type PendingInteraction } from "../../lib/runtime-store";
import { useUiStore } from "../../lib/store";
import { cn } from "../../lib/cn";
import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { MarkdownViewer } from "../../components/markdown-viewer/MarkdownViewer";
import { extractArtifactRefs, refToArtifactBlock, fileInspectorFromBlock } from "../../lib/artifacts";
import { setCurrentCwd } from "../../lib/files";
import { projectKnowledgeApi } from "../../lib/project-knowledge";
import { fetchDynamicCommands, resetDynamicCommands } from "../../lib/slash-commands";
import { SlashCommandMenu } from "../../components/SlashCommandMenu";

export function LiveSessionPage() {
  const { sessionId, cwd: rawCwd } = useParams<{ sessionId: string; cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const navigate = useNavigate();
  const {
    status, thread, working, connect, disconnect,
    sendPrompt, abort, activeSessionId, setModel: setRuntimeModel, createNewSession,
    model: runtimeModel, thinking: runtimeThinking,
    pendingInteraction, respondToInteraction,
    draft: input, setDraft: setInput,
  } = useRuntimeStore();
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [thinking, setThinking] = useState("high");
  const [modelError, setModelError] = useState<string | null>(null);
  const [reviewingProject, setReviewingProject] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);

  useEffect(() => {
    if (working && activeSessionId && activeSessionId !== (sessionId || null)) {
      navigate(
        `/workspace/${encodeURIComponent(workspaceCwd)}/session/${activeSessionId}`,
        { replace: true },
      );
    }
  }, [activeSessionId, navigate, sessionId, working, workspaceCwd]);

  useEffect(() => {
    setCurrentCwd(workspaceCwd);
    connect(workspaceCwd, sessionId || undefined);
    const workspacePrefix = `/workspace/${encodeURIComponent(workspaceCwd)}`;
    return () => {
      // Keep the conversation stream alive while the user inspects files,
      // notebooks, runs, or project knowledge in the same workspace. A later
      // session connect will replace it, and leaving the workspace closes it.
      if (!window.location.pathname.startsWith(workspacePrefix)) disconnect();
    };
  }, [sessionId, workspaceCwd, connect, disconnect]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thread.blocks]);

  useEffect(() => {
    fetch("/api/settings/config")
      .then((res) => res.json())
      .then((data) => {
        const runtime = useRuntimeStore.getState();
        setModels(Array.isArray(data.available_models) ? data.available_models : []);
        setSelectedModel(runtime.model || data.model || "");
        setThinking(runtime.thinking || data.thinking || "high");
      })
      .catch(() => setModelError("Unable to load model list"));
  }, []);

  useEffect(() => {
    if (runtimeModel) setSelectedModel(runtimeModel);
    if (runtimeThinking) setThinking(runtimeThinking);
  }, [runtimeModel, runtimeThinking]);

  useEffect(() => {
    if (activeSessionId) {
      void fetchDynamicCommands(activeSessionId, workspaceCwd);
    } else {
      resetDynamicCommands();
    }
  }, [activeSessionId, workspaceCwd]);

  const handleModelChange = async (model: string) => {
    const previousModel = selectedModel;
    const previousThinking = thinking;
    let runtimeChanged = false;
    setSelectedModel(model);
    setModelError(null);
    try {
      const runtimeSessionId = await setRuntimeModel(model, thinking);
      if (runtimeSessionId && runtimeSessionId !== sessionId) {
        navigate(
          `/workspace/${encodeURIComponent(workspaceCwd)}/session/${runtimeSessionId}`,
          { replace: true },
        );
      }
      runtimeChanged = true;
      const response = await fetch("/api/settings/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, thinking }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Unable to save model: ${response.statusText}`);
      }
    } catch (e) {
      let rolledBack = !runtimeChanged;
      if (runtimeChanged && previousModel) {
        try {
          const runtimeSessionId = await setRuntimeModel(previousModel, previousThinking);
          if (runtimeSessionId && runtimeSessionId !== sessionId) {
            navigate(
              `/workspace/${encodeURIComponent(workspaceCwd)}/session/${runtimeSessionId}`,
              { replace: true },
            );
          }
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
      }
      setSelectedModel(rolledBack ? previousModel : model);
      const message = e instanceof Error ? e.message : "Unable to set model";
      setModelError(rolledBack ? message : `${message}; runtime rollback also failed`);
    }
  };

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    for (const f of arr) {
      const form = new FormData();
      form.append("file", f);
      try {
        const res = await fetch(`/api/files/upload?cwd=${encodeURIComponent(workspaceCwd)}`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
        setFiles((prev) => [...prev, f]);
      } catch (err) {
        console.error("Upload failed:", err);
      }
    }
  }, [workspaceCwd]);

  const runSlashCommand = async (value: string): Promise<boolean> => {
    const match = value.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return false;
    const [, name, rawArgs = ""] = match;
    const args = rawArgs.trim();
    if (name === "new") {
      const newId = await createNewSession();
      navigate(`/workspace/${encodeURIComponent(workspaceCwd)}/session/${newId}`);
      return true;
    }
    if (name === "name") {
      if (activeSessionId && args) {
        setSessionName(activeSessionId, args);
        setReviewNotice(`Session renamed to ${args}`);
      }
      return true;
    }
    if (name === "model") {
      if (args) await handleModelChange(args);
      return true;
    }
    if (name === "compact") {
      if (!activeSessionId) return true;
      const response = await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/compact?${new URLSearchParams({ cwd: workspaceCwd })}`, { method: "POST" });
      if (!response.ok) throw new Error("Unable to compact the current session");
      setReviewNotice("Session compacted");
      return true;
    }
    if (name === "session") {
      setReviewNotice(activeSessionId ? `Session ${activeSessionId.slice(0, 8)}` : "No active session");
      return true;
    }
    if (name === "copy") {
      const lastAgent = [...thread.blocks].reverse().find((block) => block.kind === "agent");
      const text = lastAgent?.kind === "agent" ? lastAgent.parts.map((part) => part.text).join("") : "";
      if (text && navigator.clipboard) await navigator.clipboard.writeText(text);
      return true;
    }
    if (name === "export") {
      if (!activeSessionId) return true;
      const format = args === "jsonl" ? "jsonl" : "html";
      const params = new URLSearchParams({ cwd: workspaceCwd, format });
      window.open(`/api/sessions/${encodeURIComponent(activeSessionId)}/export?${params}`, "_blank", "noopener,noreferrer");
      return true;
    }
    return false;
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && files.length === 0) || working || reviewingProject) return;

    if (text.startsWith("/") && files.length === 0 && await runSlashCommand(text)) {
      setInput("");
      return;
    }

    let message = text;
    if (files.length > 0) {
      const names = files.map((f) => f.name).join(", ");
      message = text
        ? `${text}\n\n[Attached files: ${names}]`
        : `I've uploaded these files: ${names}`;
    }

    const sentFiles = files;
    setInput("");
    setFiles([]);
    void sendPrompt(message).catch(() => {
      // Keep the failed message visible with its inline error, but restore the
      // original draft/attachments so retrying does not require retyping.
      if (!useRuntimeStore.getState().draft) setInput(text);
      setFiles((current) => current.length > 0 ? current : sentFiles);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void uploadFiles(e.dataTransfer.files);
    }
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void uploadFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handleProjectReview = async () => {
    if (reviewingProject || working) return;
    setReviewingProject(true);
    setReviewNotice(null);
    try {
      const result = await projectKnowledgeApi.review(workspaceCwd, activeSessionId);
      setReviewNotice(result.created > 0 ? `${result.created} update proposal${result.created === 1 ? "" : "s"} added` : result.message);
    } catch (cause) {
      setReviewNotice(cause instanceof Error ? cause.message : "Project review failed");
    } finally {
      setReviewingProject(false);
    }
  };

  const title = activeSessionId ? (getSessionName(activeSessionId) || activeSessionId.slice(0, 8)) : "New Session";

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

      {/* Thread */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] flex flex-col gap-4 px-8 py-6">
          {thread.blocks.length === 0 && !working && (
            <WelcomeScreen
              onPick={(msg) => void sendPrompt(msg).catch(() => undefined)}
              disabled={reviewingProject || (!activeSessionId && status === "connecting")}
            />
          )}
          {renderBlocks(thread.blocks)}
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
      <div className="px-8 pb-5 pt-2 shrink-0">
        <div
          className={cn(
            "relative mx-auto max-w-[760px] rounded-card border bg-surface shadow-card transition-colors",
            dragOver ? "border-accent bg-accent/5" : "border-border",
          )}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
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
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={dragOver ? "Drop files here…" : "Ask anything — analyze data, run code, explore results"}
            rows={2}
            className="max-h-[160px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-text outline-none placeholder:text-muted"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-input px-2 py-1 text-xs text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1"
              >
                <Paperclip size={13} /> Attach
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
              <select
                aria-label="Select model"
                value={selectedModel}
                onChange={(e) => void handleModelChange(e.target.value)}
                disabled={working || reviewingProject || !activeSessionId}
                className="min-w-0 max-w-[300px] rounded-input border border-border bg-surface-2 px-2 py-1 text-[11px] text-text outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                {models.length === 0 && <option value={selectedModel}>{selectedModel || "Loading models…"}</option>}
                {models.length > 0 && selectedModel && !models.some((model) => model.id === selectedModel) && (
                  <option value={selectedModel}>{selectedModel}</option>
                )}
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              {modelError && <span className="max-w-[180px] truncate text-[10px] text-error" title={modelError}>{modelError}</span>}
              {reviewNotice && <span className="max-w-[220px] truncate text-[10px] text-muted" title={reviewNotice}>{reviewNotice}</span>}
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFilePick} />
            {working ? (
              <button aria-label="Stop generation" onClick={() => void abort().catch(() => undefined)} className="h-7 w-7 rounded-input bg-accent text-accent-fg flex items-center justify-center hover:bg-error transition-colors">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                aria-label="Send message"
                onClick={handleSend}
                disabled={reviewingProject || (!activeSessionId && status === "connecting") || (!input.trim() && files.length === 0)}
                className={cn(
                  "h-7 w-7 rounded-input flex items-center justify-center",
                  (!reviewingProject && (activeSessionId || status !== "connecting") && (input.trim() || files.length > 0)) ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted cursor-default",
                )}
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function InteractionPrompt({
  interaction,
  onRespond,
}: {
  interaction: PendingInteraction;
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
}) {
  const [value, setValue] = useState(interaction.prefill || "");

  useEffect(() => {
    setValue(interaction.prefill || "");
  }, [interaction.requestId, interaction.prefill]);

  const options = (interaction.options || []).map((option) => (
    typeof option === "string"
      ? { label: option, value: option }
      : { label: option.label || option.value || "Option", value: option.value || option.label || "" }
  ));

  return (
    <div className="rounded-card border border-accent/30 bg-accent/5 p-4 animate-fadeIn">
      <div className="text-sm font-medium text-text">{interaction.title}</div>
      {interaction.message && <div className="mt-1 text-sm leading-relaxed text-muted">{interaction.message}</div>}

      {interaction.method === "confirm" ? (
        <div className="mt-3 flex gap-2">
          <button onClick={() => onRespond({ confirmed: true })} className="rounded-input bg-accent px-3 py-1.5 text-xs text-accent-fg">Confirm</button>
          <button onClick={() => onRespond({ confirmed: false })} className="rounded-input border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-2">Decline</button>
        </div>
      ) : interaction.method === "select" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((option) => (
            <button
              key={`${option.label}-${option.value}`}
              onClick={() => onRespond({ value: option.value })}
              className="rounded-input border border-border bg-surface px-3 py-1.5 text-xs text-text hover:border-accent"
            >
              {option.label}
            </button>
          ))}
          <button onClick={() => onRespond({ cancelled: true })} className="rounded-input px-3 py-1.5 text-xs text-muted hover:bg-surface-2">Cancel</button>
        </div>
      ) : (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={interaction.placeholder}
            rows={interaction.method === "editor" ? 4 : 2}
            className="min-h-10 flex-1 resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
          <button
            onClick={() => onRespond({ value })}
            disabled={!value.trim()}
            className="rounded-input bg-accent px-3 py-2 text-xs text-accent-fg disabled:cursor-default disabled:opacity-50"
          >
            Submit
          </button>
          <button onClick={() => onRespond({ cancelled: true })} className="rounded-input px-2 py-2 text-xs text-muted hover:bg-surface-2">Cancel</button>
        </div>
      )}
    </div>
  );
}

/** Render blocks, grouping consecutive tool cards together. */
function renderBlocks(blocks: ThreadBlock[]) {
  const result: React.ReactNode[] = [];
  let toolGroup: ToolCallBlock[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "tool") {
      toolGroup.push(block);
    } else {
      if (toolGroup.length > 0) {
        result.push(<ToolGroup key={toolGroup[0].id} blocks={toolGroup} />);
        toolGroup = [];
      }
      result.push(<BlockRenderer key={block.id} block={block} />);
    }
  }
  if (toolGroup.length > 0) {
    result.push(<ToolGroup key={toolGroup[0].id} blocks={toolGroup} />);
  }
  return result;
}

/* ── Block Renderers ── */

function BlockRenderer({ block }: { block: ThreadBlock }) {
  switch (block.kind) {
    case "user": return <UserMessage text={block.text} />;
    case "agent": return <AgentMessage parts={block.parts} partial={block.partial} />;
    case "tool": return <ToolCard block={block} />;
    case "status-line": return <StatusLine block={block} />;
    default: return null;
  }
}

/** Group consecutive tool blocks into a collapsible summary.
 *  Shows individual cards while any tool is still running;
 *  collapses into a summary line once all are done. */
function ToolGroup({ blocks }: { blocks: ToolCallBlock[] }) {
  const [expanded, setExpanded] = useState(false);
  if (blocks.length <= 1) return <ToolCard block={blocks[0]} />;

  const allDone = blocks.every((block) => block.status === "done" || block.status === "error");
  const doneCount = blocks.filter((block) => block.status === "done").length;
  const tools = [...new Set(blocks.map((block) => block.tool))].join(", ");

  // While tools are running, show individual cards inline (no jumping)
  if (!allDone) {
    return <>{blocks.map((b) => <ToolCard key={b.id} block={b} />)}</>;
  }

  // All done — collapse into summary
  return (
    <div className="rounded-input border border-border bg-surface overflow-hidden animate-fadeIn">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-[12.5px] text-muted hover:bg-surface-2"
      >
        <span className="text-xs">{expanded ? "▼" : "▶"}</span>
        <span>{tools}</span>
        <span className="ml-auto text-[10px]">
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

function UserMessage({ text }: { text: string }) {
  return (
    <div className="rounded-card bg-surface-2 px-4 py-3 text-[15px] leading-relaxed text-text ml-auto max-w-[85%]">
      {text}
    </div>
  );
}

function AgentMessage({ parts, partial }: { parts: { id: string; text: string }[]; partial?: boolean }) {
  const text = parts.map((p) => p.text).join("");
  const openInspector = useUiStore((s) => s.openInspector);
  if (!text && partial) return null;
  if (!text) return null;

  // Detect file references and make them clickable
  const refs = extractArtifactRefs(text);

  const handleFileClick = (filePath: string) => {
    const block = refToArtifactBlock(filePath);
    const inspector = fileInspectorFromBlock(block as any);
    openInspector(inspector as any);
  };

  return (
    <div>
      <MarkdownViewer variant="chat">{text}</MarkdownViewer>
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
    </div>
  );
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

function StatusLine({ block }: { block: { kind: "status-line"; text: string; level: string } }) {
  const tone = block.level === "error" ? "text-error" : block.level === "done" ? "text-ok" : "text-muted";
  return (
    <div className={cn("flex items-center gap-2 text-xs", tone)}>
      {block.level === "running" && <Loader2 size={14} className="animate-spin text-accent" />}
      {block.text}
    </div>
  );
}

/* ── Welcome ── */

function WelcomeScreen({ onPick, disabled = false }: { onPick: (msg: string) => void; disabled?: boolean }) {
  const starters = [
    {
      icon: "📊", label: "Analyze data",
      desc: "Load a CSV, NetCDF, or FITS file and find patterns.",
      prompt: "Analyze the dataset in this directory and give me key statistical insights.",
    },
    {
      icon: "📝", label: "Write report",
      desc: "Generate a scientific report from the findings.",
      prompt: "Write a scientific report based on the data analysis results.",
    },
    {
      icon: "🐍", label: "Run Python",
      desc: "Execute code in an interactive notebook session.",
      prompt: "Write and run a Python script to process the data files in this workspace.",
    },
    {
      icon: "🔬", label: "Run experiment",
      desc: "Design and execute a computational experiment.",
      prompt: "Design an experiment to test the hypothesis and run the analysis.",
    },
  ];

  return (
    <div className="min-h-[62vh] flex flex-col items-center justify-center">
      <div className="max-w-[500px]">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-muted">
          Scientific AI Workbench
        </p>
        <h2 className="font-serif text-[26px] leading-tight text-text mt-1.5">
          Pi-Science
        </h2>
        <p className="text-sm leading-relaxed text-muted mt-2">
          Powered by the pi agent runtime. Analyze data, run code, and explore results with AI assistance.
        </p>
      </div>

      <div className="mt-7 rounded-card border border-border bg-surface shadow-card w-full max-w-[500px]">
        {starters.map((s, i) => (
          <button
            key={s.label}
            onClick={() => onPick(s.prompt)}
            disabled={disabled}
            className={cn(
              "group flex w-full items-center gap-3.5 px-4 py-3.5 text-left disabled:cursor-wait disabled:opacity-50",
              !disabled && "hover:bg-surface-2",
              i > 0 && "border-t border-border",
              i === 0 && "rounded-t-card",
              i === starters.length - 1 && "rounded-b-card",
            )}
          >
            <span className="h-9 w-9 rounded-full bg-surface-2 text-accent ring-1 ring-border flex items-center justify-center shrink-0 text-lg">
              {s.icon}
            </span>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-text">{s.label}</div>
              <div className="text-xs leading-snug text-muted mt-0.5">{s.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
