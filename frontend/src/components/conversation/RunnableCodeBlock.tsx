import { useState } from "react";
import { Loader2, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { notebookRuntime, type CellResult } from "../../lib/notebook";
import { CodeBlockFrame } from "../markdown-viewer/CodeBlockFrame";

/** Chat code block with a Run affordance in the code banner: executes python
 *  on the workspace kernel bridge and shows stdout/result/error inline. */
export function RunnableCodeBlock({ code, language, cwd, sessionId, preClassName, children }: {
  code: string;
  language?: string | null;
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
      setResult(await notebookRuntime.execute(notebookId, cwd, "python", code, sessionId));
    } catch (cause) {
      setResult({ ok: false, stdout: "", result: null, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="relative">
      <CodeBlockFrame
        language={language}
        code={code}
        preClassName={preClassName}
        bannerExtra={
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            aria-label={running ? t("conversation.runningCode") : t("conversation.runCode")}
            className="flex h-6 items-center gap-1 rounded px-1.5 font-sans text-[11px] text-muted transition-colors hover:bg-surface-raised hover:text-text disabled:cursor-wait"
          >
            {running ? <Loader2 size={11} className="animate-spin text-accent" /> : <Play size={11} />}
            {running ? t("conversation.runningCode") : t("conversation.runCode")}
          </button>
        }
      >
        {children}
      </CodeBlockFrame>
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
