import { useState } from "react";
import { BookmarkPlus, Check, Loader2, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { useFeedback } from "../feedback/feedback-context";
import { fileInspectorForPath } from "../../lib/artifacts";
import { notebookRuntime, type CellResult } from "../../lib/notebook";

type SaveState = "idle" | "saving" | "saved" | "error";

/** Chat code block with a Claude analysis-tool style "Run" affordance: executes
 *  python on the workspace kernel bridge and shows stdout/result/error inline.
 *  When the block belongs to a settled agent message, a "Save to notebook"
 *  action persists the code (and its last run output) into the session notebook
 *  artifact (idempotent per session/message/source-line). */
export function RunnableCodeBlock({ code, cwd, sessionId, preClassName, children, modelAtSave, messageId, messageTimestamp, messageComplete, sourceLine }: {
  code: string;
  cwd: string;
  sessionId: string;
  preClassName?: string;
  children: React.ReactNode;
  modelAtSave?: string;
  messageId?: string;
  messageTimestamp?: string;
  messageComplete?: boolean;
  sourceLine?: number;
}) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const openInspector = useUiStore((s) => s.openInspector);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CellResult | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | undefined>(undefined);
  // One scratch notebook per conversation: every chat block shares that kernel,
  // so variables defined in one block persist into the next (Claude Science notebook behavior).
  const notebookId = `chat-${sessionId}`;

  // Saving needs a settled agent message that owns this block; partial (still
  // streaming) blocks cannot be saved because their message id is not final.
  const saveable = Boolean(code.trim() && messageId && messageComplete !== false);
  const saving = saveState === "saving";
  const busy = running || saving;

  const run = async () => {
    if (running || !code.trim()) return;
    setRunning(true);
    setResult(null);
    // A fresh run changes the cell output; the previous save snapshot is stale.
    setSaveState("idle");
    try {
      setResult(await notebookRuntime.execute(notebookId, cwd, "python", code));
    } catch (cause) {
      setResult({ ok: false, stdout: "", result: null, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    if (busy || !saveable || !messageId) return;
    setSaveState("saving");
    try {
      const response = await notebookRuntime.saveChatCell(cwd, {
        session_id: sessionId,
        message_id: messageId,
        source_line: sourceLine,
        language: "python",
        code,
        result: result ?? undefined,
        model_at_save: modelAtSave,
        message_timestamp: messageTimestamp,
      });
      setSavedPath(response.path);
      setSavedRevision(response.revision);
      setSaveState("saved");
      toast(t("conversation.savedToNotebook", { path: response.path }), "success");
      openInspector(fileInspectorForPath(response.path, undefined, undefined, cwd, response.revision));
    } catch (cause) {
      setSaveState("error");
      toast(cause instanceof Error ? cause.message : t("conversation.notebookSaveFailed"), "error");
    }
  };

  const openSavedNotebook = () => {
    if (savedPath) openInspector(fileInspectorForPath(savedPath, undefined, undefined, cwd, savedRevision));
  };

  const saveLabel = saveState === "saved"
    ? t("conversation.openNotebook")
    : saveState === "saving"
      ? t("conversation.savingToNotebook")
      : t("conversation.saveToNotebook");

  return (
    <div className="relative">
      <pre className={cn(preClassName, result && "mb-1.5")}>{children}</pre>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          aria-label={t("conversation.runCode")}
          className="flex items-center gap-1 rounded-input border border-border bg-surface px-1.5 py-0.5 font-sans text-[11px] text-muted shadow-card transition-colors hover:text-text disabled:cursor-wait disabled:opacity-60"
        >
          {running ? <Loader2 size={11} className="animate-spin text-accent" /> : <Play size={11} />}
          {running ? t("conversation.runningCode") : t("conversation.runCode")}
        </button>
        {saveable && (
          <button
            type="button"
            onClick={() => void (saveState === "saved" ? openSavedNotebook() : save())}
            disabled={busy}
            aria-label={t("conversation.saveToNotebook")}
            title={t("conversation.saveToNotebook")}
            className={cn(
              "flex items-center gap-1 rounded-input border px-1.5 py-0.5 font-sans text-[11px] shadow-card transition-colors disabled:cursor-wait disabled:opacity-60",
              saveState === "saved"
                ? "border-ok/30 bg-ok/5 text-ok"
                : saveState === "error"
                  ? "border-error/30 bg-error/5 text-error"
                  : "border-border bg-surface text-muted hover:text-text",
            )}
          >
            {saving ? <Loader2 size={11} className="animate-spin text-accent" /> : saveState === "saved" ? <Check size={11} /> : <BookmarkPlus size={11} />}
            {saveLabel}
          </button>
        )}
      </div>
      {result && (
        <div className="mb-3 rounded-input bg-surface-2 font-mono text-[12px]">
          <div className="flex items-center justify-between gap-2 border-b border-faint px-3 py-1.5 font-sans text-[10px] uppercase tracking-wider text-muted">
            <span>{t("conversation.codeOutput")}</span>
            <button type="button" aria-label={t("conversation.closeOutput")} onClick={() => setResult(null)} className="text-muted hover:text-text">
              <X size={11} />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto px-3 py-2 leading-5">
            {result.stdout && <pre className="whitespace-pre-wrap break-all text-text">{result.stdout}</pre>}
            {result.result && <pre className="whitespace-pre-wrap break-all text-text">{result.result}</pre>}
            {result.error && <pre className="whitespace-pre-wrap break-all text-error">{result.error}</pre>}
            {!result.stdout && !result.result && !result.error && <span className="text-ok">✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}
