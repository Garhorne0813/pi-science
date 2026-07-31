import { useCallback, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { setSessionName } from "../lib/pi-science-client";
import { useRuntimeStore } from "../lib/runtime-store";
import { useUiStore } from "../lib/store";
import { apiRequest } from "../lib/api";
import { injectWorkspaceReferences } from "../lib/file-references";
import { lastCompletedAgentMessageText } from "../lib/message-actions";
import { parseSuggestions } from "../lib/suggestions";
import { useFeedback } from "../components/feedback/feedback-context";
import type { ResearchLoopDraft, ResearchStarter } from "../components/conversation/ResearchLoopControls";

/**
 * Composer state and send pipeline: attachments, drag-and-drop, IME guards,
 * slash-command dispatch, and the research-intent detour before a normal send.
 */
export function useComposer(params: {
  cwd: string;
  selectedModel: string;
  onModelCommand: (model: string) => void;
  reviewingProject: boolean;
  setReviewNotice: (notice: string) => void;
  research: {
    mode: ResearchStarter | null;
    draft: ResearchLoopDraft | null;
    intent: (text: string) => Promise<{ kind: "draft" } | { kind: "conversation"; message: string } | null>;
  };
}) {
  const { cwd, selectedModel, onModelCommand, reviewingProject, setReviewNotice, research } = params;
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const location = useLocation();
  const thread = useRuntimeStore((s) => s.thread);
  const working = useRuntimeStore((s) => s.working);
  const sendPrompt = useRuntimeStore((s) => s.sendPrompt);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const createNewSession = useRuntimeStore((s) => s.createNewSession);
  const input = useRuntimeStore((s) => s.draft);
  const setInput = useRuntimeStore((s) => s.setDraft);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Track IME composition state ourselves because some browsers fire
  // compositionend before keydown, making isComposing unreliable for
  // Enter-to-confirm-raw-pinyin use cases.
  const composingRef = useRef(false);
  const allWorkspaceReferences = useUiStore((state) => state.workspaceReferences);
  const workspaceReferences = useMemo(
    () => allWorkspaceReferences.filter((item) => item.cwd === cwd),
    [allWorkspaceReferences, cwd],
  );
  const clearWorkspaceReferences = useUiStore((state) => state.clearWorkspaceReferences);

  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    for (const f of arr) {
      const form = new FormData();
      form.append("file", f);
      try {
        await apiRequest(`/api/files/upload?cwd=${encodeURIComponent(cwd)}`, {
          method: "POST",
          body: form,
        });
        setFiles((prev) => [...prev, f]);
      } catch (err) {
        toast(err instanceof Error ? err.message : t("conversation.uploadError"), "error");
      }
    }
  }, [t, toast, cwd]);

  const runSlashCommand = async (value: string): Promise<boolean> => {
    const match = value.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return false;
    const [, name, rawArgs = ""] = match;
    const args = rawArgs.trim();
    if (name === "new") {
      const newId = await createNewSession();
      navigate(`/workspace/${encodeURIComponent(cwd)}/session/${newId}`);
      return true;
    }
    if (name === "name") {
      if (activeSessionId && args) {
        setSessionName(cwd, activeSessionId, args);
        setReviewNotice(`Session renamed to ${args}`);
      }
      return true;
    }
    if (name === "model") {
      if (args) await onModelCommand(args);
      return true;
    }
    if (name === "compact") {
      if (!activeSessionId) return true;
      await apiRequest(`/api/sessions/${encodeURIComponent(activeSessionId)}/compact?${new URLSearchParams({ cwd })}`, { method: "POST" });
      setReviewNotice("Session compacted");
      return true;
    }
    if (name === "session") {
      setReviewNotice(activeSessionId ? `Session ${activeSessionId.slice(0, 8)}` : "No active session");
      return true;
    }
    if (name === "copy") {
      const text = parseSuggestions(lastCompletedAgentMessageText(thread.blocks)).clean;
      if (text && navigator.clipboard) await navigator.clipboard.writeText(text);
      return true;
    }
    if (name === "export") {
      if (!activeSessionId) return true;
      const format = args === "jsonl" ? "jsonl" : "html";
      const params = new URLSearchParams({ cwd, format });
      window.open(`/api/sessions/${encodeURIComponent(activeSessionId)}/export?${params}`, "_blank", "noopener,noreferrer");
      return true;
    }
    return false;
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!selectedModel || (!text && files.length === 0 && workspaceReferences.length === 0) || working || reviewingProject) return;
    let workflowMessage: string | null = null;
    if (research.mode && !research.draft && text) {
      const prepared = await research.intent(text);
      if (!prepared) return;
      if (prepared.kind === "draft") { setInput(""); return; }
      workflowMessage = prepared.message;
    }

    if (text.startsWith("/") && files.length === 0 && workspaceReferences.length === 0 && await runSlashCommand(text)) {
      setInput("");
      return;
    }

    let message = workflowMessage ?? text;
    if (files.length > 0) {
      const names = files.map((f) => f.name).join(", ");
      message = message
        ? `${message}\n\n[Attached files: ${names}]`
        : `I've uploaded these files: ${names}`;
    }

    message = injectWorkspaceReferences(message, workspaceReferences);

    const sentFiles = files;
    const sentReferences = workspaceReferences;
    setInput("");
    setFiles([]);
    clearWorkspaceReferences(cwd);
    void sendPrompt(message)
      .then((sentSessionId) => {
        // A first prompt on a workspace landing route (no :sessionId segment)
        // creates the session lazily. Mirror the /new command and adopt the new
        // session id in the URL; otherwise the route stays on the bare
        // workspace path and a later connect() without a sessionId clears the
        // thread back to the blank composer.
        if (sentSessionId && !location.pathname.match(/\/session\/[^/]+$/)) {
          navigate(`/workspace/${encodeURIComponent(cwd)}/session/${sentSessionId}`, { replace: true });
        }
      })
      .catch(() => {
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

  return {
    input, setInput, files, setFiles, dragOver, setDragOver,
    fileInputRef, inputRef, composingRef, workspaceReferences,
    handleSend, handleKeyDown, handleDrop, handleFilePick,
  };
}
