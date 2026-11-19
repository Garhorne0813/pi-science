import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import hljs from "highlight.js/lib/common";
import { cn } from "@/lib/ui";
import { shouldSkipAutoDetect, shouldSkipHighlight } from "@/lib/artifacts/highlight-policy";
import { isSelectAllShortcut, selectAllWithin } from "@/lib/ui/select-all-within";
import "./highlight-theme.css";

interface Props {
  code: string;
  language?: string;
  startLine?: number;
  className?: string;
  fontSize?: number;
}

/** Read-only code with a line-number gutter. Scrolls horizontally; no wrapping. */
export function CodeViewer({ code, language, startLine = 1, className, fontSize = 12.5 }: Props) {
  const { t } = useTranslation();
  const codeRef = useRef<HTMLElement>(null);
  const lineCount = useMemo(() => code.replace(/\n$/, "").split("\n").length, [code]);
  const skipHighlight = shouldSkipHighlight(code);
  const skipAuto = !language && !skipHighlight && shouldSkipAutoDetect(code);
  const skipReason = skipHighlight ? "size" : skipAuto ? "noLanguage" : null;

  const html = useMemo(() => {
    if (skipHighlight || skipAuto) return escapeHtml(code);
    try {
      // An explicit plaintext request and an unknown declared language both
      // render unhighlighted. Auto-detection is only for text files with no
      // declared language, and is capped by the size guards above.
      if (language === "plaintext") return escapeHtml(code);
      if (!language) return hljs.highlightAuto(code).value;
      if (!hljs.getLanguage(language)) return escapeHtml(code);
      return hljs.highlight(code, { language }).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language, skipHighlight, skipAuto]);

  const viewer = (
    <div
      className={cn("flex overflow-x-auto rounded-input border border-border bg-surface font-mono text-[12.5px] leading-[1.55] outline-none focus-visible:ring-2 focus-visible:ring-accent/40", className)}
      style={{ fontSize: Math.round(fontSize * 100) / 100 }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (!isSelectAllShortcut(event.nativeEvent) || !codeRef.current) return;
        if (selectAllWithin(codeRef.current)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div
        aria-hidden
        className="select-none border-r border-border bg-surface-2 px-3 py-3 text-right text-muted"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{startLine + i}</div>
        ))}
      </div>
      <pre className="flex-1 overflow-visible px-4 py-3">
        <code ref={codeRef} className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );

  if (!skipReason) return viewer;
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2">
      <div
        role="status"
        className="rounded-input border border-accent/25 bg-accent/5 px-3 py-2 text-xs text-muted"
      >
        {t(skipReason === "size" ? "filePreview.highlightSkipped" : "filePreview.highlightSkippedNoLanguage")}
      </div>
      {viewer}
    </div>
  );
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
