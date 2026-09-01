import { isValidElement, useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Check, Copy, File } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/ui";
import { fenceLanguage, runnableLanguage } from "@/lib/conversation";
import { RunnableCodeBlock } from "../conversation/RunnableCodeBlock";
import { CodeBlockFrame } from "./CodeBlockFrame";
import { fileInspectorForPath } from "@/lib/artifacts";
import { resolveMarkdownResource, type MarkdownResourceContext } from "@/lib/files/markdown-resources";
import { useUiStore } from "@/lib/ui";

type Variant = "chat" | "document";

const STYLES: Record<Variant, Record<string, string>> = {
  chat: {
    root: "text-[15px] leading-[1.65] text-text",
    p: "my-2 first:mt-0 last:mb-0",
    a: "text-link underline underline-offset-2 [overflow-wrap:anywhere]",
    code: "rounded bg-surface-selected px-1 py-0.5 font-mono text-[13px] text-text [overflow-wrap:anywhere]",
    pre: "overflow-x-auto p-3 font-mono text-[13px] leading-5 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-text",
    ul: "my-2 ml-5 list-disc space-y-1",
    ol: "my-2 ml-5 list-decimal space-y-1",
    h1: "mb-3 mt-5 text-2xl font-semibold first:mt-0",
    h2: "mb-2 mt-5 text-xl font-semibold first:mt-0",
    h3: "mb-2 mt-4 text-lg font-semibold first:mt-0",
    h4: "mb-1.5 mt-3 text-base font-semibold first:mt-0",
    h5: "mb-1 mt-3 text-sm font-semibold first:mt-0",
    h6: "mb-1 mt-3 text-xs font-semibold uppercase tracking-wide first:mt-0",
    blockquote: "my-2 border-l-2 border-border pl-3 text-muted",
    hr: "my-4 border-border",
    table: "border-collapse text-sm",
    th: "border border-border bg-surface-2 px-3 py-1.5 text-left font-semibold",
    td: "border border-border px-3 py-1.5",
  },
  document: {
    root: "text-[15px] leading-[1.65] text-[var(--doc-ink)] antialiased [font-feature-settings:'liga','kern'] [font-family:-apple-system,'SF_Pro_Text','Segoe_UI','PingFang_SC','Microsoft_YaHei',sans-serif] selection:bg-[var(--doc-selection)]",
    p: "my-1.5 tracking-[0.006em] [text-wrap:pretty] first:mt-0 last:mb-0",
    a: "font-medium text-[var(--doc-accent)] underline decoration-[var(--doc-accent-underline)] decoration-1 underline-offset-[3px] transition-colors hover:decoration-[var(--doc-accent)] [overflow-wrap:anywhere]",
    code: "rounded-[4px] bg-[var(--doc-code-bg)] px-1.5 py-0.5 font-mono text-[13px] text-[var(--doc-code-ink)] ring-1 ring-[var(--doc-code-ring)] [overflow-wrap:anywhere]",
    pre: "my-3 overflow-x-auto rounded-lg bg-[var(--doc-pre-bg)] p-3 font-mono text-[13px] leading-5 ring-1 ring-[var(--doc-pre-ring)] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[var(--doc-pre-ink)] [&_code]:ring-0",
    ul: "my-2 ml-5 list-disc space-y-1 marker:text-[var(--doc-marker)]",
    ol: "my-2 ml-5 list-decimal space-y-1 marker:text-[13px] marker:font-medium marker:text-[var(--doc-marker)]",
    h1: "mb-3 mt-5 text-2xl font-bold leading-[1.25] tracking-[-0.01em] text-[var(--doc-ink-strong)] [text-wrap:balance] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h2: "mb-2 mt-5 flex items-baseline gap-2 text-xl font-semibold leading-snug tracking-[-0.005em] text-[var(--doc-ink-strong)] [text-wrap:balance] before:relative before:top-[0.14em] before:h-[0.82em] before:w-[3px] before:shrink-0 before:rounded-full before:bg-[var(--doc-h2-bar)] before:content-[''] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h3: "mb-2 mt-4 text-lg font-semibold leading-snug text-[var(--doc-ink)] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h4: "mb-1.5 mt-3 text-base font-semibold uppercase tracking-[0.08em] text-[var(--doc-ink-muted)] first:mt-0",
    h5: "mb-1 mt-3 text-sm font-semibold leading-snug text-[var(--doc-ink)] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h6: "mb-1 mt-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--doc-ink-muted)] first:mt-0",
    blockquote: "my-2 rounded-r-md border-l-[3px] border-[var(--doc-quote-bar)] bg-[var(--doc-quote-bg)] py-1.5 pl-3 pr-4 text-[var(--doc-quote-ink)] [&_p]:my-1.5",
    hr: "mx-auto my-4 w-12 border-t-2 border-[var(--doc-hr)]",
    table: "border-collapse text-sm tabular-nums",
    th: "border-b-2 border-[var(--doc-table-head-line)] px-3 py-1.5 text-left font-semibold text-[var(--doc-ink-strong)]",
    td: "border-b border-[var(--doc-table-line)] px-3 py-1.5",
  },
};

export type CodeRunner = { cwd: string; sessionId: string };

function reactText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactText).join("");
  if (isValidElement(node)) return reactText((node.props as { children?: React.ReactNode }).children);
  return "";
}

function mathSource(node: React.ReactNode): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const source = mathSource(child);
      if (source !== null) return source;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as { encoding?: unknown; children?: React.ReactNode };
  if (props.encoding === "application/x-tex") return reactText(props.children);
  return mathSource(props.children);
}

function MathBlock({ children, variant }: { children?: React.ReactNode; variant: Variant }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const source = mathSource(children);
  const copy = async () => {
    if (source === null) return;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be unavailable outside a secure browser context.
    }
  };
  return (
    <div className="katex-display group relative my-4 overflow-x-auto overflow-y-hidden pt-7">
      <button
        type="button"
        onClick={() => void copy()}
        disabled={source === null}
        aria-label={copied ? t("conversation.copied") : t("conversation.copy")}
        title={copied ? t("conversation.copied") : t("conversation.copy")}
        className={cn(
          "absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100 disabled:cursor-default disabled:opacity-40",
          variant === "chat"
            ? "bg-surface text-muted hover:text-text"
            : "bg-[var(--doc-paper)] text-[var(--doc-ink-muted)] hover:text-[var(--doc-accent)]",
        )}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {children}
    </div>
  );
}

const FILE_HREF = /^(?!(?:https?:\/\/|mailto:|#|data:|file:))/i;

function ResourceImage({ src, alt }: { src: string; alt?: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span role="img" aria-label={alt ?? ""} className="my-3 inline-block rounded-input border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
        {t("filePreview.imageFailed")}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      onError={() => setFailed(true)}
      className="my-3 max-h-[480px] max-w-full rounded border border-border"
    />
  );
}

export function stripStrayClosingBrace(tex: string): string {
  const match = /^(.*?)[ \t]+\}\s*$/s.exec(tex);
  if (!match) return tex;
  const before = match[1] ?? "";
  if (/\\right\}$|\]$|\)$|\}$/.test(before)) return before;
  return tex;
}

/** Fenced and inline code are protected as spans. Indented code is protected
 * line-by-line so its newline stays visible to the later display-math checks.
 * A four-space line directly continuing a list item is prose in CommonMark,
 * not a top-level indented code block, so leave it eligible for math rewrite. */
const FENCE_PATTERN = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;
const INDENTED_CODE_LINE_PATTERN = /^(?: {4}|\t)[^\n]*$/;
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/;
const INLINE_CODE_PATTERN = /(`+)[^`\n]*?\1/g;

const PLACEHOLDER_SALT = Math.random().toString(36).slice(2, 8);
const placeholder = (index: number): string => `\uE000${PLACEHOLDER_SALT}${index}\uE001`;
const PLACEHOLDER_RE = new RegExp(`\uE000${PLACEHOLDER_SALT}(\\d+)\uE001`, "g");

function protectIndentedCodeLines(md: string, protect: (match: string) => string): string {
  const lines = md.split("\n");
  let previousWasListItem = false;
  return lines.map((line) => {
    const isListItem = LIST_ITEM_PATTERN.test(line);
    const shouldProtect = INDENTED_CODE_LINE_PATTERN.test(line) && !previousWasListItem;
    previousWasListItem = isListItem;
    return shouldProtect ? protect(line) : line;
  }).join("\n");
}

function protectCodeSpans(md: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  const protect = (match: string) => {
    spans.push(match);
    return placeholder(spans.length - 1);
  };
  const withFences = md.replace(FENCE_PATTERN, protect);
  const withIndented = protectIndentedCodeLines(withFences, protect);
  return { text: withIndented.replace(INLINE_CODE_PATTERN, protect), spans };
}

function restoreCodeSpans(text: string, spans: string[]): string {
  return text.replace(PLACEHOLDER_RE, (_m, index: string) => {
    const n = Number(index);
    return Number.isInteger(n) && n >= 0 && n < spans.length ? spans[n] : _m;
  });
}

export function normalizeMathInput(md: string): string {
  const { text, spans } = protectCodeSpans(md);
  const delimited = text
    .replace(/(^|\n)\\\[([\s\S]*?)\\\](?=[ \t]*(?:\n|$))/g, (_whole, lead: string, inner: string) =>
      `${lead}$$\n${stripStrayClosingBrace(inner).trim()}\n$$`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_whole, inner: string) => `$${inner}$`);
  const fixed = delimited.replace(/\$\$([\s\S]*?)\$\$/g, (whole, inner: string, offset: number) => {
    const lineStart = delimited.lastIndexOf("\n", offset - 1);
    const prefix = delimited.slice(lineStart + 1, offset);
    const after = delimited.slice(offset + whole.length);
    if (prefix !== "" || !/^[ \t]*(?:\n|$)/.test(after)) return whole;
    const braced = stripStrayClosingBrace(String(inner));
    const trimmed = braced.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (trimmed.includes("\n")) {
      return `$$${braced.endsWith("\n") ? braced : `${braced}\n`}$$`;
    }
    return `$$\n${trimmed}\n$$`;
  });
  return restoreCodeSpans(fixed, spans);
}

export function MarkdownViewer({
  children,
  className,
  variant = "chat",
  codeRunner,
  resourceContext,
  codeChrome,
}: {
  children: string;
  className?: string;
  variant?: Variant;
  codeRunner?: CodeRunner;
  resourceContext?: MarkdownResourceContext;
  codeChrome?: boolean;
}) {
  const s = STYLES[variant];
  const cwd = codeRunner?.cwd;
  const openInspector = useUiStore((s) => s.openInspector);
  const { t } = useTranslation();
  const context = useMemo<MarkdownResourceContext | undefined>(
    () => resourceContext ?? (cwd ? { cwd, documentPath: undefined } : undefined),
    [cwd, resourceContext],
  );
  const handleFileLink = useCallback((href: string) => {
    if (!context) return;
    const resolved = resolveMarkdownResource(href, context);
    if (resolved.kind !== "workspace") return;
    const filename = resolved.path.split(/[\\/]/).at(-1) || resolved.path;
    openInspector(fileInspectorForPath(resolved.path, filename, context.root, cwd));
  }, [context, cwd, openInspector]);
  return (
    <div className={cn(s.root, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        skipHtml
        components={{
          p: ({ children }) => <p className={s.p}>{children}</p>,
          img: ({ src, alt }) => {
            const href = src ?? "";
            if (!href.trim()) {
              return (
                <span role="img" aria-label={alt ?? ""} className="my-3 inline-block rounded-input border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                  {t("filePreview.imageFailed")}
                </span>
              );
            }
            if (!context) return <ResourceImage src={href} alt={alt} />;
            const resolved = resolveMarkdownResource(href, context);
            if (resolved.kind === "invalid") {
              return (
                <span role="img" aria-label={alt ?? ""} className="my-3 inline-block rounded-input border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                  {t("filePreview.imageFailed")}
                </span>
              );
            }
            return <ResourceImage src={resolved.url} alt={alt} />;
          },
          a: ({ children, href: rawHref }) => {
            const href = rawHref ?? "";
            if (context && FILE_HREF.test(href)) {
              return (
                <span
                  onClick={(e) => { e.preventDefault(); handleFileLink(href); }}
                  className={`${s.a} inline-flex items-center gap-1 cursor-pointer`}
                  title={href}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") handleFileLink(href); }}
                >
                  <File size={12} className="shrink-0" />
                  {children}
                </span>
              );
            }
            return <a href={rawHref} className={s.a}>{children}</a>;
          },
          code: ({ children }) => <code className={s.code}>{children}</code>,
          span: ({ children, className, node: _node, ...props }) => {
            if (className === "katex-display") return <MathBlock variant={variant}>{children}</MathBlock>;
            return <span {...props} className={className}>{children}</span>;
          },
          pre: ({ children }) => {
            const codeEl = Array.isArray(children) ? children[0] : children;
            const codeProps = isValidElement(codeEl) ? (codeEl.props as { className?: string; children?: React.ReactNode }) : null;
            const language = codeProps ? fenceLanguage(codeProps.className) : null;
            const code = codeProps ? reactText(codeProps.children) : "";
            const chrome = variant === "chat" && (codeChrome ?? true);
            if (chrome && codeProps) {
              if (codeRunner && runnableLanguage(language)) {
                return (
                  <RunnableCodeBlock code={code} language={language} cwd={codeRunner.cwd} sessionId={codeRunner.sessionId} preClassName={s.pre}>
                    {children}
                  </RunnableCodeBlock>
                );
              }
              return <CodeBlockFrame language={language} code={code} preClassName={s.pre}>{children}</CodeBlockFrame>;
            }
            if (variant === "chat") return <pre className={cn(s.pre, "my-2 rounded-input border border-border bg-surface-2")}>{children}</pre>;
            return <pre className={s.pre}>{children}</pre>;
          },
          ul: ({ children }) => <ul className={s.ul}>{children}</ul>,
          ol: ({ children }) => <ol className={s.ol}>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          h1: ({ children }) => <h1 className={s.h1}>{children}</h1>,
          h2: ({ children }) => <h2 className={s.h2}>{children}</h2>,
          h3: ({ children }) => <h3 className={s.h3}>{children}</h3>,
          h4: ({ children }) => <h4 className={s.h4}>{children}</h4>,
          h5: ({ children }) => <h5 className={s.h5}>{children}</h5>,
          h6: ({ children }) => <h6 className={s.h6}>{children}</h6>,
          blockquote: ({ children }) => <blockquote className={s.blockquote}>{children}</blockquote>,
          hr: () => <hr className={s.hr} />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto"><table className={s.table}>{children}</table></div>
          ),
          th: ({ children, style }) => <th className={s.th} style={style}>{children}</th>,
          td: ({ children, style }) => <td className={s.td} style={style}>{children}</td>,
        }}
      >
        {normalizeMathInput(children)}
      </ReactMarkdown>
    </div>
  );
}
