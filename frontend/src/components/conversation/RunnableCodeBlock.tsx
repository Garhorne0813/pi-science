import { useState } from "react";
import { Loader2, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { notebookRuntime, type CellResult } from "../../lib/notebook-runtime";

/** Chat code block with a Claude analysis-tool style "Run" affordance: executes
 *  python on the workspace kernel bridge and shows stdout/result/error inline. */
export function RunnableCodeBlock({ code, cwd, sessionId, preClassName, children }: {
  code: string;
  cwd: string;
  sessionId: string;
  preClassName?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CellResult | null>(null);
  // One scratch notebook per conversation: every chat block shares that kernel,
  // so variables defined in one block persist into the next (Claude Science notebook behavior).
  const notebookId = `chat-${sessionId}`;

  const run = async () => {
    if (running || !code.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await notebookRuntime.execute(notebookId, cwd, "python", code));
    } catch (cause) {
      setResult({ ok: false, stdout: "", result: null, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="relative">
      <pre className={cn(preClassName, result && "mb-1.5")}>{children}</pre>
      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        aria-label={t("conversation.runCode")}
        className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-input border border-border bg-surface px-1.5 py-0.5 font-sans text-[11px] text-muted shadow-card transition-colors hover:text-text disabled:cursor-wait"
      >
        {running ? <Loader2 size={11} className="animate-spin text-accent" /> : <Play size={11} />}
        {running ? t("conversation.runningCode") : t("conversation.runCode")}
      </button>
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
