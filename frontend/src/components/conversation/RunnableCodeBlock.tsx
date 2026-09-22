import { Loader2, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CellResult } from "../../lib/notebook";
import { CodeBlockFrame } from "../markdown-viewer/CodeBlockFrame";

/** Chat code block with a Run affordance in the code banner: executes python
 *  on the workspace kernel bridge and shows stdout/result/error inline. */
export function RunnableCodeBlock({ code, language, preClassName, children, running, result, onRun, onCloseResult }: {
  code: string;
  language?: string | null;
  preClassName?: string;
  children: React.ReactNode;
  running: boolean;
  result: CellResult | null;
  onRun: () => void;
  onCloseResult: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative">
      <CodeBlockFrame
        language={language}
        code={code}
        preClassName={preClassName}
        bannerExtra={
          <button
            type="button"
            onClick={onRun}
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
            <button type="button" aria-label={t("conversation.closeOutput")} onClick={onCloseResult} className="text-muted hover:text-text">
              <X size={11} />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto px-3 py-2 leading-5">
            {result.stdout && <pre className="whitespace-pre-wrap break-all text-text">{result.stdout}</pre>}
            {result.result && <pre className="whitespace-pre-wrap break-all text-text">{result.result}</pre>}
            {result.error && <pre className="whitespace-pre-wrap break-all text-error-text">{result.error}</pre>}
            {!result.stdout && !result.result && !result.error && <span className="text-ok-text">✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}
