import { useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/ui";

export function NotebookCodePreview({
  code,
  language = "python",
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => {
    try {
      return hljs.getLanguage(language)
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);
  const lines = Math.max(1, code.replace(/\n$/, "").split("\n").length);

  const copy = async () => {
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={cn("notebook-code-preview group/code relative flex min-w-0 overflow-auto", className)}>
      <div aria-hidden className="sticky left-0 z-[1] shrink-0 select-none border-r border-faint px-3 py-3 text-right font-mono text-[11px] leading-[1.65] text-muted/55">
        {Array.from({ length: lines }, (_, index) => <div key={index}>{index + 1}</div>)}
      </div>
      <pre className="min-w-max flex-1 px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-text">
        <code className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html || " " }} />
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy code"
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-raised text-muted opacity-0 shadow-sm transition hover:text-text group-hover/code:opacity-100 focus:opacity-100"
      >
        {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
