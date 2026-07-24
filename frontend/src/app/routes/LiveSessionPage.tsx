import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowUp, Loader2, Square, Paperclip, Sparkles, X, File, FolderOpen } from "lucide-react";
import { clampThinkingLevel, getSessionName, setSessionName, type AvailableModel } from "../../lib/pi-science-client";
import { applySessionReplacements, useRuntimeStore, type PendingInteraction, type SessionReplacement } from "../../lib/runtime-store";
import { useUiStore } from "../../lib/store";
import { cn } from "../../lib/cn";
import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { MarkdownViewer } from "../../components/markdown-viewer/MarkdownViewer";
import { extractArtifactRefs, refToArtifactBlock, fileInspectorFromBlock } from "../../lib/artifacts";
import { setCurrentCwd } from "../../lib/files";
import { projectKnowledgeApi } from "../../lib/project-knowledge";
import { fetchDynamicCommands, resetDynamicCommands } from "../../lib/slash-commands";
import { SlashCommandMenu } from "../../components/SlashCommandMenu";
import { injectWorkspaceReferences, referencesFromMessage, visibleUserMessage } from "../../lib/file-references";
import { ConversationWelcome } from "../../components/conversation/ConversationWelcome";
import { MessageActions } from "../../components/conversation/MessageActions";
import { ModelControlMenu } from "../../components/conversation/ModelControlMenu";
import { useTranslation } from "react-i18next";

export function LiveSessionPage() {
  const { t } = useTranslation();
  const { sessionId, cwd: rawCwd } = useParams<{ sessionId: string; cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const navigate = useNavigate();
  const {
    status, thread, sessions, working, connect, disconnect,
    sendPrompt, abort, activeSessionId, createNewSession,
    model: runtimeModel, thinking: runtimeThinking,
    pendingInteraction, respondToInteraction,
    draft: input, setDraft: setInput,
  } = useRuntimeStore();
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  // Track IME composition state ourselves because some browsers fire
  // compositionend before keydown, making isComposing unreliable for
  // Enter-to-confirm-raw-pinyin use cases.
  const composingRef = useRef(false);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [thinking, setThinking] = useState("high");
  const [modelError, setModelError] = useState<string | null>(null);
  const [configuringModel, setConfiguringModel] = useState(false);
  const [reviewingProject, setReviewingProject] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const allWorkspaceReferences = useUiStore((state) => state.workspaceReferences);
  const workspaceReferences = useMemo(
    () => allWorkspaceReferences.filter((item) => item.cwd === workspaceCwd),
    [allWorkspaceReferences, workspaceCwd],
  );
  const removeWorkspaceReference = useUiStore((state) => state.removeWorkspaceReference);
  const clearWorkspaceReferences = useUiStore((state) => state.clearWorkspaceReferences);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== (sessionId || null)) {
      navigate(
        `/workspace/${encodeURIComponent(workspaceCwd)}/session/${activeSessionId}`,
        { replace: true },
      );
    }
  }, [activeSessionId, navigate, sessionId, workspaceCwd]);

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

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && followOutputRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [thread.blocks]);

  const handleThreadScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    followOutputRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  };

  useEffect(() => {
    if (!activeSessionId) return;
    fetch(`/api/settings/config?cwd=${encodeURIComponent(workspaceCwd)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || data.detail || `Unable to load model list: ${res.statusText}`);
        return data;
      })
      .then((data) => {
        const runtime = useRuntimeStore.getState();
        const allAvailableModels: AvailableModel[] = Array.isArray(data.available_models) ? data.available_models : [];
        const configuredProvider = typeof data.model === "string" ? data.model.split("/", 1)[0] : "";
        const availableModels = configuredProvider
          ? allAvailableModels.filter((model) => model.provider === configuredProvider)
          : [];
        setModels(availableModels);
        const nextModel = runtime.model || data.model || "";
        const nextModelInfo = availableModels.find((model: AvailableModel) => model.id === nextModel);
        const supported = nextModelInfo?.thinking_levels || [];
        const configuredThinking = runtime.thinking || data.thinking || "high";
        setSelectedModel(nextModel);
        setThinking(supported.length > 0 ? clampThinkingLevel(configuredThinking, supported) : configuredThinking);
        setModelError(availableModels.length === 0
          ? "Configure a provider and model in Settings before sending a message."
          : null);
      })
      .catch((cause) => setModelError(cause instanceof Error ? cause.message : "Unable to load model list"));
  }, [activeSessionId, workspaceCwd]);

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

  const selectedModelInfo = models.find((model) => model.id === selectedModel);
  const thinkingLevels = selectedModelInfo?.thinking_levels?.length
    ? selectedModelInfo.thinking_levels
    : selectedModel
      ? [thinking]
      : [];
  const modelControlsDisabled = working || reviewingProject || configuringModel;

  const applyModelConfig = async (model: string, nextThinking: string) => {
    const previousModel = selectedModel;
    const previousThinking = thinking;
    setSelectedModel(model);
    setThinking(nextThinking);
    setModelError(null);
    setConfiguringModel(true);
    try {
      const response = await fetch(`/api/settings/model?cwd=${encodeURIComponent(workspaceCwd)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, thinking: nextThinking }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.detail || `Unable to save model: ${response.statusText}`);
      }
      const replacementId = applySessionReplacements(
        Array.isArray(data.session_replacements) ? data.session_replacements as SessionReplacement[] : [],
      );
      setSelectedModel(typeof data.model === "string" ? data.model : model);
      setThinking(typeof data.thinking === "string" ? data.thinking : nextThinking);
      if (replacementId && replacementId !== sessionId) {
        navigate(
          `/workspace/${encodeURIComponent(workspaceCwd)}/session/${replacementId}`,
          { replace: true },
        );
      }
    } catch (e) {
      setSelectedModel(previousModel);
      setThinking(previousThinking);
      const message = e instanceof Error ? e.message : "Unable to set model";
      setModelError(message);
    } finally {
      setConfiguringModel(false);
    }
  };

  const handleModelChange = (model: string) => {
    const nextModelInfo = models.find((item) => item.id === model);
    const supported = nextModelInfo?.thinking_levels || [];
    void applyModelConfig(model, clampThinkingLevel(thinking, supported));
  };

  const handleThinkingChange = (level: string) => {
    if (!selectedModel) return;
    void applyModelConfig(selectedModel, level);
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
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || data.detail || "Unable to compact the current session");
      }
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
    if (!selectedModel || (!text && files.length === 0 && workspaceReferences.length === 0) || working || reviewingProject) return;

    if (text.startsWith("/") && files.length === 0 && workspaceReferences.length === 0 && await runSlashCommand(text)) {
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

    message = injectWorkspaceReferences(message, workspaceReferences);

    const sentFiles = files;
    const sentReferences = workspaceReferences;
    setInput("");
    setFiles([]);
    clearWorkspaceReferences(workspaceCwd);
    void sendPrompt(message).catch(() => {
      // Keep the failed message visible with its inline error, but restore the
      // original draft/attachments so retrying does not require retyping.
      if (!useRuntimeStore.getState().draft) setInput(text);
      setFiles((current) => current.length > 0 ? current : sentFiles);
      sentReferences.forEach((reference) => useUiStore.getState().addWorkspaceReference(reference));
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Skip when IME is composing (e.g. Chinese Pinyin user presses
    // Enter to confirm raw pinyin as English — that Enter belongs
    // to the IME, not the app).  We check both isComposing and our
    // own ref because some browsers fire compositionend before keydown.
    if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing && !composingRef.current) {
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

  const hasUserMessage = thread.blocks.some((block) => block.kind === "user");
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const isNewSession = !hasUserMessage && (activeSession?.name === "New Session" || thread.loaded);
  const title = isNewSession || !activeSessionId
    ? t("conversation.newSession")
    : getSessionName(activeSessionId) || activeSession?.name || activeSessionId.slice(0, 8);

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
      <div ref={scrollRef} onScroll={handleThreadScroll} className="flex-1 overflow-y-auto [overflow-anchor:none]">
        <div className="mx-auto max-w-[760px] flex flex-col gap-4 px-8 py-6">
          {thread.blocks.length === 0 && !working && (
            <ConversationWelcome
              onPick={(msg) => void sendPrompt(msg).catch(() => undefined)}
              disabled={!selectedModel || reviewingProject || (!activeSessionId && status === "connecting")}
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
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; }, 0); }}
            placeholder={dragOver ? "Drop files here…" : "Ask anything — analyze data, run code, explore results"}
            rows={2}
            className="max-h-[160px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-text outline-none placeholder:text-muted"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
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
              {modelError && <span className="max-w-[180px] truncate text-[10px] text-error" title={modelError}>{modelError}</span>}
              {reviewNotice && <span className="max-w-[220px] truncate text-[10px] text-muted" title={reviewNotice}>{reviewNotice}</span>}
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFilePick} />
            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              {models.length > 0 && (
                <ModelControlMenu
                  models={models}
                  selectedModel={selectedModel}
                  thinking={thinking}
                  thinkingLevels={thinkingLevels}
                  disabled={modelControlsDisabled}
                  onModelChange={handleModelChange}
                  onThinkingChange={handleThinkingChange}
                />
              )}
              {working ? (
                <button aria-label="Stop generation" onClick={() => void abort().catch(() => undefined)} className="h-7 w-7 rounded-input bg-accent text-accent-fg flex items-center justify-center hover:bg-error transition-colors">
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  aria-label="Send message"
                  onClick={handleSend}
                  disabled={!selectedModel || reviewingProject || (!activeSessionId && status === "connecting") || (!input.trim() && files.length === 0 && workspaceReferences.length === 0)}
                  className={cn(
                    "h-7 w-7 rounded-input flex items-center justify-center",
                    (selectedModel && !reviewingProject && (activeSessionId || status !== "connecting") && (input.trim() || files.length > 0 || workspaceReferences.length > 0)) ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted cursor-default",
                  )}
                >
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
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
    case "user": return <UserMessage text={block.text} timestamp={block.timestamp} />;
    case "agent": return <AgentMessage parts={block.parts} partial={block.partial} timestamp={block.timestamp} />;
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

function UserMessage({ text, timestamp }: { text: string; timestamp?: string }) {
  const visibleText = visibleUserMessage(text);
  const references = referencesFromMessage(text);
  const copyText = visibleText || references.map((reference) => reference.path).join("\n");
  return (
    <div className="group/message ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
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

function AgentMessage({ parts, partial, timestamp }: { parts: { id: string; text: string }[]; partial?: boolean; timestamp?: string }) {
  const text = parts.map((p) => p.text).join("");
  const openInspector = useUiStore((s) => s.openInspector);
  if (!text && partial) return null;
  if (!text) return null;

  // Detect file references and make them clickable
  const refs = extractArtifactRefs(text);
  const citations = [...new Set(text.match(/10\.\d{4,9}\/[^\s)\]}>]+/gi) || [])];

  const handleFileClick = (filePath: string) => {
    const block = refToArtifactBlock(filePath);
    const inspector = fileInspectorFromBlock(block as any);
    openInspector(inspector as any);
  };

  return (
    <div className="group/message">
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
      {citations.length > 0 && <CitationBadges identifiers={citations} />}
      {!partial && <MessageActions text={text} timestamp={timestamp} />}
    </div>
  );
}

function CitationBadges({ identifiers }: { identifiers: string[] }) {
  const [states, setStates] = useState<Record<string, string>>(() => Object.fromEntries(identifiers.map((id) => [id, "unverified"])));
  const verify = async (identifier: string) => {
    setStates((current) => ({ ...current, [identifier]: "checking" }));
    try {
      const normalized = await fetch("/api/citations/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifiers: [identifier] }) }).then((response) => response.json());
      const citation = normalized.citations?.[0];
      if (!citation) throw new Error("not found");
      const result = await fetch("/api/citations/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ citation }) }).then((response) => response.json());
      setStates((current) => ({ ...current, [identifier]: result.verification || "unverified" }));
    } catch {
      setStates((current) => ({ ...current, [identifier]: "network_error" }));
    }
  };
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {identifiers.map((identifier) => (
        <button key={identifier} type="button" onClick={() => void verify(identifier)} className="rounded-input border border-border bg-surface px-2 py-1 font-mono text-[10px] text-muted hover:bg-surface-2" title="Verify citation against a provider">
          DOI · {states[identifier]}
        </button>
      ))}
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
