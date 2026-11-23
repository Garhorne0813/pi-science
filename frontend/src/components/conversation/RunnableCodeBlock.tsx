import { ArrowUpRight, Loader2, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CellResult } from "../../lib/notebook";
import { CodeBlockFrame } from "../markdown-viewer/CodeBlockFrame";
import { NotebookMimeOutput } from "../notebook/NotebookMimeOutput";
import { StoredOutputs } from "../notebook/NotebookOutputs";

/** Chat code block with a Run affordance in the code banner: executes python
 *  on the workspace kernel bridge and shows stdout/result/error inline. */
export function RunnableCodeBlock({ code, language, preClassName, children, running, result, onRun, onCloseResult, onOpenRun }: {
  code: string;
  language?: string | null;
  preClassName?: string;
  children: React.ReactNode;
  running: boolean;
  result: CellResult | null;
  onRun: () => void;
  onCloseResult: () => void;
  onOpenRun?: (executionId: string) => void;
}) {
  const { t } = useTranslation();
  const outputs = result?.outputs?.length ? result.outputs : null;
  const mime = result?.mime && Object.keys(result.mime).length > 0 ? result.mime : null;
  const executionId = result?.execution_id;

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
      {/* Run output exists only in this panel, never in the message markdown, so
          a quote must not be able to claim it came from the message. */}
      {result && (
        <div data-quote-exclude="" className="mb-3 rounded-input bg-surface-2 font-mono text-[12px]">
          <div className="flex items-center justify-between gap-2 border-b border-faint px-3 py-1.5 font-sans text-[10px] uppercase tracking-wider text-muted">
            <span>{t("conversation.codeOutput")}</span>
            <span className="flex items-center gap-2">
              {executionId && onOpenRun && (
                <button type="button" onClick={() => onOpenRun(executionId)} className="flex items-center gap-0.5 normal-case tracking-normal text-muted hover:text-text">
                  {t("conversation.viewRun")} <ArrowUpRight size={10} />
                </button>
              )}
              <button type="button" aria-label={t("conversation.closeOutput")} onClick={onCloseResult} className="text-muted hover:text-text">
                <X size={11} />
              </button>
            </span>
          </div>
          <div className="max-h-[420px] overflow-y-auto px-3 py-2 leading-5">
            {/* stdout/stderr and rich outputs are separate channels in a kernel result:
                a cell can print text and also emit a display_data image. Render both.
                A trailing expression lands in both `result` and `outputs`, so the
                result/mime branches are only used when there are no structured outputs. */}
            {result.stdout && <pre className="whitespace-pre-wrap break-all text-text">{result.stdout}</pre>}
            {result.stderr && <pre className="whitespace-pre-wrap break-all text-warn-text">{result.stderr}</pre>}
            {outputs ? <StoredOutputs outputs={outputs} /> : (
              <>
                {result.result && !mime && <pre className="whitespace-pre-wrap break-all text-text">{result.result}</pre>}
                {mime && <div className="mt-2"><NotebookMimeOutput mime={mime} label={t("conversation.codeOutput")} /></div>}
              </>
            )}
            {result.error && <pre className="whitespace-pre-wrap break-all text-error-text">{result.error}</pre>}
            {result.ok && !outputs && !mime && !result.stdout && !result.stderr && !result.result && !result.error && <span className="text-ok-text">✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}
