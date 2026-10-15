import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useRuntimeStore } from "../lib/agent-runtime";
import { useUiStore } from "../lib/ui";
import { apiRequest } from "../lib/client/api";
import { injectWorkspaceReferences } from "../lib/files";
import { useFeedback } from "../components/feedback/feedback-context";
import type { ResearchStarter } from "../components/conversation/ResearchModePicker";
import { injectSubagentMentions } from "../lib/conversation";
import { inlineWorkspaceReferences, validComposerEntities, type ComposerEntity } from "../lib/conversation/composer-document";

/**
 * Composer state and send pipeline: attachments, drag-and-drop, IME guards,
 * slash-command dispatch, and conversation-native research skill invocation.
 */
export function useComposer(params: {
  cwd: string;
  conversationKey?: string | null;
  selectedModel: string;
  configuringModel?: boolean;
  reviewingProject: boolean;
  setReviewNotice: (notice: string) => void;
  research: {
    mode: ResearchStarter | null;
    setMode: (mode: ResearchStarter | null) => void;
  };
  /** Fired right before a real message is dispatched. */
  onSend?: () => void;
}) {
  const { cwd, conversationKey = null, selectedModel, configuringModel = false, reviewingProject, setReviewNotice, research, onSend } = params;
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const location = useLocation();
  const working = useRuntimeStore((s) => s.working);
  const sendPrompt = useRuntimeStore((s) => s.sendPrompt);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const input = useRuntimeStore((s) => s.draft);
  const setDraft = useRuntimeStore((s) => s.setDraft);
  const composerRevisionRef = useRef(0);
  const setInput = useCallback((value: string) => { composerRevisionRef.current += 1; setDraft(value); }, [setDraft]);
  const [files, updateFiles] = useState<File[]>([]);
  const [entities, updateEntities] = useState<ComposerEntity[]>([]);
  const setFiles = useCallback<React.Dispatch<React.SetStateAction<File[]>>>((value) => { composerRevisionRef.current += 1; updateFiles(value); }, []);
  const setEntities = useCallback<React.Dispatch<React.SetStateAction<ComposerEntity[]>>>((value) => { composerRevisionRef.current += 1; updateEntities(value); }, []);
  const validEntities = useMemo(() => validComposerEntities(input, entities), [input, entities]);
  const mentions = useMemo(() => validEntities.flatMap((entity) => entity.kind === "mention"
    ? [{ id: entity.id, name: entity.name, start: entity.start, end: entity.end }] : []), [validEntities]);
  const inlineReferences = useMemo(() => inlineWorkspaceReferences(validEntities), [validEntities]);
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
  const composerContextRef = useRef<{ cwd: string; conversationKey: string | null; sessionId: string | null } | null>(null);

  useEffect(() => {
    const unsubscribeRuntime = useRuntimeStore.subscribe((state, previous) => {
      if (state.draft !== previous.draft || (previous.activeSessionId !== null && state.activeSessionId !== previous.activeSessionId)) composerRevisionRef.current += 1;
    });
    const unsubscribeUi = useUiStore.subscribe((state, previous) => {
      const current = state.workspaceReferences.filter((reference) => reference.cwd === cwd);
      const before = previous.workspaceReferences.filter((reference) => reference.cwd === cwd);
      if (current.length !== before.length || current.some((reference, index) => reference !== before[index])) composerRevisionRef.current += 1;
    });
    return () => { unsubscribeRuntime(); unsubscribeUi(); composerRevisionRef.current += 1; };
  }, [cwd]);

  useEffect(() => {
    const composerContext = { cwd, conversationKey, sessionId: activeSessionId };
    const previousContext = composerContextRef.current;
    composerContextRef.current = composerContext;
    const sameDraft = previousContext?.cwd === cwd && previousContext.conversationKey === conversationKey;
    // Attaching a runtime to the current blank draft is not switching conversations.
    // Keep text, mentions, references and attachments while slash discovery initializes it.
    const adoptedDraft = sameDraft && previousContext?.sessionId === null && activeSessionId !== null;
    if (previousContext && (!sameDraft || previousContext.sessionId !== activeSessionId) && !adoptedDraft) {
      setInput("");
      setEntities([]);
      setFiles([]);
      clearWorkspaceReferences(cwd);
    }
    // Support opening a fresh conversation with a pre-filled prompt from
    // another surface (e.g. the Skills "let the assistant write it" dialog).
    const initialDraft = (location.state as { initialDraft?: string } | null)?.initialDraft;
    if (initialDraft && !useRuntimeStore.getState().draft) {
      setInput(initialDraft);
    }
  }, [activeSessionId, clearWorkspaceReferences, conversationKey, cwd, location.state, setEntities, setFiles, setInput]);

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
  }, [t, toast, cwd, setFiles]);

  const runSlashCommand = async (value: string): Promise<"handled" | "requires-session" | false> => {
    const match = value.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return false;
    const [, name, rawArgs = ""] = match;
    const args = rawArgs.trim();
    if (name === "compact") {
      if (!activeSessionId) {
        toast(t("conversation.commandRequiresSession"), "error");
        return "requires-session";
      }
      await apiRequest(`/api/sessions/${encodeURIComponent(activeSessionId)}/compact?${new URLSearchParams({ cwd })}`, { method: "POST" });
      setReviewNotice("Session compacted");
      return "handled";
    }
    if (name === "export") {
      if (!activeSessionId) {
        toast(t("conversation.commandRequiresSession"), "error");
        return "requires-session";
      }
      const format = args === "jsonl" ? "jsonl" : "html";
      const params = new URLSearchParams({ cwd, format });
      window.open(`/api/sessions/${encodeURIComponent(activeSessionId)}/export?${params}`, "_blank", "noopener,noreferrer");
      return "handled";
    }
    return false;
  };

  const handleSend = async () => {
    const originalDraft = input;
    const text = input.trim();
    const references = [...inlineReferences, ...workspaceReferences].filter((reference, index, all) =>
      all.findIndex((other) => other.cwd === reference.cwd && other.path === reference.path) === index);
    if (!selectedModel || (!text && files.length === 0 && references.length === 0) || working || reviewingProject || configuringModel) return;
    if (text.startsWith("/") && mentions.length === 0 && files.length === 0 && references.length === 0) {
      const slashResult = await runSlashCommand(text);
      if (slashResult === "requires-session") return;
      if (slashResult === "handled") {
        setInput("");
        return;
      }
    }

    let message = text;
    if (files.length > 0) {
      const names = files.map((f) => f.name).join(", ");
      message = message
        ? `${message}\n\n[Attached files: ${names}]`
        : `I've uploaded these files: ${names}`;
    }

    message = injectSubagentMentions(message, mentions);
    message = injectWorkspaceReferences(message, references);

    const sentResearchMode = research.mode;
    if (sentResearchMode) message = `/skill:auto-research [Workflow: ${sentResearchMode}]\n${message}`;

    const sentFiles = files;
    const sentReferences = workspaceReferences;
    const sentEntities = entities;
    setInput("");
    research.setMode(null);
    setEntities([]);
    setFiles([]);
    clearWorkspaceReferences(cwd);
    const sentRevision = composerRevisionRef.current;
    onSend?.();
    // A late result belongs to the conversation that sent the prompt. The composer records
    // that context, so a user who opened another conversation meanwhile is left alone.
    const sentFrom = conversationKey;
    void sendPrompt(message)
      .then((sentSessionId) => {
        // A first prompt on a workspace landing route (no :sessionId segment)
        // creates the session lazily. Adopt the new session id in the URL;
        // otherwise the route stays on the bare
        // workspace path and a later connect() without a sessionId clears the
        // thread back to the blank composer.
        if (!sentSessionId || composerContextRef.current?.conversationKey !== sentFrom) return;
        if (!window.location.pathname.match(/\/session\/[^/]+$/)) {
          navigate(`/workspace/${encodeURIComponent(cwd)}/session/${sentSessionId}`, { replace: true });
        }
      })
      .catch(() => {
        // The thread keeps the failed message and its retry action when a newer draft owns the composer.
        const composer = composerContextRef.current;
        if (composer?.cwd !== cwd || composer.conversationKey !== sentFrom || composerRevisionRef.current !== sentRevision || useRuntimeStore.getState().draft) return;
        setInput(originalDraft);
        research.setMode(sentResearchMode);
        setEntities(sentEntities);
        setFiles(sentFiles);
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
    input, setInput, entities, setEntities, mentions, files, setFiles, dragOver, setDragOver,
    fileInputRef, inputRef, composingRef, workspaceReferences,
    handleSend, handleKeyDown, handleDrop, handleFilePick,
  };
}
