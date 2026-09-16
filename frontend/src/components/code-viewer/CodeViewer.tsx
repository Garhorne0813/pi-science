import { useMemo, useRef } from "react";
import hljs from "highlight.js/lib/common";
import { cn } from "@/lib/ui";
import { isSelectAllShortcut, selectAllWithin } from "@/lib/ui/select-all-within";
import "./highlight-theme.css";

interface Props {
  code: string;
  language?: string;
  startLine?: number;
  className?: string;
}

/** Read-only code with a line-number gutter. Scrolls horizontally; no wrapping. */
export function CodeViewer({ code, language, startLine = 1, className }: Props) {
  const codeRef = useRef<HTMLElement>(null);
  const html = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);

  const lineCount = code.replace(/\n$/, "").split("\n").length;

  return (
    <div
      className={cn("flex overflow-x-auto rounded-input border border-border bg-surface font-mono text-[12.5px] leading-[1.55] outline-none focus-visible:ring-2 focus-visible:ring-accent/40", className)}
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
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
