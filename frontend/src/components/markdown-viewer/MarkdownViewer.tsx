import { isValidElement, useCallback, useState } from "react";
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
import { fileInspectorForPath } from "@/lib/artifacts";
import { useUiStore } from "@/lib/ui";

/** Two contexts render markdown: chat bubbles (theme colors, compact) and the
 *  file-preview "paper" (document-neutral black-on-white, editorial scale —
 *  like the Office previews, a document keeps its own colors in dark mode). */
type Variant = "chat" | "document";

const STYLES: Record<Variant, Record<string, string>> = {
  chat: {
    // Assistant prose reads in a serif (Claude-style response typography);
    // UI chrome and code stay sans/mono. CJK falls back to system serif.
    root: "text-[15.5px] leading-[1.75] text-text [font-family:'Source_Serif_4','Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    p: "my-2 first:mt-0 last:mb-0",
    a: "text-link underline underline-offset-2",
    code: "rounded bg-surface-2 px-1 py-0.5 font-mono text-[13px] text-link",
    pre: "my-3 overflow-x-auto rounded-input bg-surface-2 p-3 font-mono text-[13px] leading-5 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-text",
    ul: "my-2 ml-5 list-disc space-y-1",
    ol: "my-2 ml-5 list-decimal space-y-1",
    h1: "mb-3 mt-5 text-2xl font-semibold first:mt-0",
    h2: "mb-2 mt-5 text-xl font-semibold first:mt-0",
    h3: "mb-2 mt-4 text-lg font-semibold first:mt-0",
    h4: "mb-1.5 mt-3 text-base font-semibold first:mt-0",
    blockquote: "my-2 border-l-2 border-border pl-3 text-muted",
    hr: "my-4 border-border",
    table: "border-collapse text-sm",
    th: "border border-border bg-surface-2 px-3 py-1.5 text-left font-semibold",
    td: "border border-border px-3 py-1.5",
  },
  // Editorial-blog paper: warm ink on white, serif headings, terracotta accent
  // (#c15f3c — the app's brand). Theme-independent by design: a document reads
  // the same in light or dark mode, so colors are fixed, not tokens.
  //
  // Two font stacks, both explicit so the paper never inherits the app's UI
  // font. Body: a comfortable reading sans (SF/Segoe + PingFang for Chinese).
  // Headings: the finest reading serifs that actually ship on macOS/Windows
  // (Iowan/Charter → Georgia), CJK falling back to Songti.
  document: {
    root: "text-[16px] leading-[1.8] text-[#2b2620] antialiased [font-feature-settings:'liga','kern'] [font-family:-apple-system,'SF_Pro_Text','Segoe_UI','PingFang_SC','Microsoft_YaHei',sans-serif] selection:bg-[#f2d9cd]",
    p: "my-4 tracking-[0.006em] [text-wrap:pretty] first:mt-0 last:mb-0",
    a: "font-medium text-[#bf5a34] underline decoration-[#e2bdac] decoration-1 underline-offset-[3px] transition-colors hover:decoration-[#bf5a34]",
    code: "rounded-[4px] bg-[#f7f0ea] px-1.5 py-0.5 font-mono text-[13px] text-[#a94e2c] ring-1 ring-[#eee0d6]",
    pre: "my-5 overflow-x-auto rounded-lg bg-[#faf6f2] p-4 font-mono text-[13px] leading-6 ring-1 ring-[#ece2d9] [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[#4b433a] [&_code]:ring-0",
    ul: "my-4 ml-[1.15em] list-disc space-y-2 marker:text-[#c98a6b]",
    ol: "my-4 ml-[1.15em] list-decimal space-y-2 marker:text-[13px] marker:font-medium marker:text-[#c98a6b]",
    // Serif display headings give the editorial/blog feel; the stack falls back
    // to system CJK serif so Chinese posts read as editorial too. Tracking stays
    // near-zero — negative tracking crams CJK glyphs.
    h1: "mb-3 mt-10 text-[33px] font-bold leading-[1.25] tracking-[-0.01em] text-[#1c1915] [text-wrap:balance] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h2: "mb-4 mt-11 flex items-baseline gap-2.5 text-[23px] font-semibold leading-snug tracking-[-0.005em] text-[#1c1915] [text-wrap:balance] before:relative before:top-[0.14em] before:h-[0.82em] before:w-[3px] before:shrink-0 before:rounded-full before:bg-[#c15f3c] before:content-[''] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h3: "mb-2 mt-8 text-[18.5px] font-semibold leading-snug text-[#2b2620] first:mt-0 [font-family:'Iowan_Old_Style','Charter',Georgia,'Songti_SC','Noto_Serif_CJK_SC',serif]",
    h4: "mb-2 mt-6 text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[#9a8d7c] first:mt-0",
    blockquote: "my-5 rounded-r-md border-l-[3px] border-[#d98c6a] bg-[#faf6f2] py-1.5 pl-5 pr-4 text-[#6b6155] [&_p]:my-1.5",
    hr: "mx-auto my-10 w-12 border-t-2 border-[#e6ddd2]",
    table: "border-collapse text-[14px] tabular-nums",
    th: "border-b-2 border-[#e2d5c8] px-4 py-2.5 text-left font-semibold text-[#1c1915]",
    td: "border-b border-[#efe8df] px-4 py-2.5",
  },
};

/** Workspace context that lets chat python fences execute on the kernel bridge. */
export type CodeRunner = { cwd: string; sessionId: string };

/** Flatten a rendered code element's children back into the fence's source text. */
function reactText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactText).join("");
  if (isValidElement(node)) return reactText((node.props as { children?: React.ReactNode }).children);
  return "";
}

/** Extract the original TeX that rehype-katex keeps in its MathML annotation. */
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
    <div
      className={cn(
        "katex-display group relative my-4 overflow-x-auto rounded-lg border px-4 pb-3 pt-7",
        variant === "chat"
          ? "border-border bg-[color-mix(in_srgb,var(--surface-2)_50%,transparent)]"
          : "border-[#e6ddd2] bg-[#faf6f2]",
      )}
    >
      <button
        type="button"
        onClick={() => void copy()}
        disabled={source === null}
        aria-label={copied ? t("conversation.copied") : t("conversation.copy")}
        title={copied ? t("conversation.copied") : t("conversation.copy")}
        className={cn(
          "absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded border opacity-70 transition-opacity hover:opacity-100 disabled:cursor-default disabled:opacity-40",
          variant === "chat"
            ? "border-border bg-surface text-muted hover:text-text"
            : "border-[#e2d5c8] bg-white/80 text-[#8d7b6b] hover:text-[#bf5a34]",
        )}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {children}
    </div>
  );
}

const FILE_HREF = /^(?!(?:https?:\/\/|mailto:|#|data:|file:))/i;

/** Tolerate a trailing stray `}` that some models append after the closing
 *  `\right\}` of a display formula (e.g. `...\right\} }$$`). KaTeX treats the
 *  stray brace as a parse error and (with throwOnError: false) silently drops
 *  the whole formula, leaving raw TeX on screen. Strip exactly one trailing
 *  `}` when it is preceded by a space and the formula otherwise ends with a
 *  balanced construct (`\right}`, `]`, `)`, or `}`). */
export function stripStrayClosingBrace(tex: string): string {
  // Match a space/tab-separated closing brace, optionally followed by
  // newlines (multi-line display formulas: `$$\n...\right\} }\n$$`). The
  // balanced-construct check keeps legitimate trailing braces (`\right\}`)
  // intact. Non-matching input is returned byte-identical, so structural
  // newlines of a display formula are never consumed.
  const match = /^(.*?)[ \t]+\}\s*$/s.exec(tex);
  if (!match) return tex;
  const before = match[1] ?? "";
  if (/\\right\}$|\]$|\)$|\}$/.test(before)) return before;
  return tex;
}

/** Fenced code block (``` or ~~~) and inline code span matchers. Fences match
 *  only at line start so indented paragraphs are untouched. Inline spans use
 *  CommonMark-style equal-length backtick runs (`` `...` `` and `` ``...`` ``
 *  both close correctly; a lone unclosed backtick is left alone). */
const FENCE_PATTERN = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;
const INLINE_CODE_PATTERN = /(`+)[^`\n]*?\1/g;

/** Unlikely salt inside the private-use-area placeholder so literal user text
 *  that happens to contain \uE000…\uE001 can never be mistaken for a guard
 *  token. Regenerated once per module load; tests share a single instance. */
const PLACEHOLDER_SALT = Math.random().toString(36).slice(2, 8);
const placeholder = (index: number): string => `\uE000${PLACEHOLDER_SALT}${index}\uE001`;
const PLACEHOLDER_RE = new RegExp(`\uE000${PLACEHOLDER_SALT}(\\d+)\uE001`, "g");

/** Replace fenced code blocks and inline code spans with private-use-area
 *  placeholders so the math normalizer never rewrites example TeX inside
 *  code. Returns the guarded text plus the captured spans in order. */
function protectCodeSpans(md: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  const protect = (match: string) => {
    spans.push(match);
    return placeholder(spans.length - 1);
  };
  const withFences = md.replace(FENCE_PATTERN, protect);
  return { text: withFences.replace(INLINE_CODE_PATTERN, protect), spans };
}

function restoreCodeSpans(text: string, spans: string[]): string {
  return text.replace(PLACEHOLDER_RE, (_m, index: string) => {
    const n = Number(index);
    return Number.isInteger(n) && n >= 0 && n < spans.length ? spans[n] : _m;
  });
}

/** Normalize math input before remark-math / rehype-katex sees the text.
 *  Two fixes for model output, applied only outside code:
 *  1. drop a stray closing `}` that models sometimes leave at the end of a
 *     display formula (`...\right\} }$$`), which makes KaTeX fail and the
 *     whole formula degrade to raw TeX (single- and multi-line forms);
 *  2. single-line `$$...$$` blocks are parsed by remark-math as INLINE math
 *     (never display), so expand them to the multi-line block form
 *     (`$$\n...\n$$`) that remark-math reliably classifies as display.
 *  Fix 2 applies ONLY to formulas that stand alone on their own line
 *  (opening `$$` at line start, closing `$$` followed only by line end).
 *  Formulas inside a sentence, blockquote (`> $$…$$`) or list (`- $$…$$`)
 *  are left untouched — expanding them would corrupt the surrounding text
 *  (remark-math already renders those cases without data loss).
 *  Fenced code blocks and inline code spans are placeholder-protected first,
 *  so example TeX inside code is never rewritten. */
export function normalizeMathInput(md: string): string {
  const { text, spans } = protectCodeSpans(md);
  const fixed = text.replace(/\$\$([\s\S]*?)\$\$/g, (whole, inner: string, offset: number) => {
    // Standalone-line check: nothing before the opening `$$` on its line and
    // nothing but whitespace after the closing `$$` until the line end.
    const lineStart = text.lastIndexOf("\n", offset - 1);
    const prefix = text.slice(lineStart + 1, offset);
    const after = text.slice(offset + whole.length);
    if (prefix !== "" || !/^[ \t]*(?:\n|$)/.test(after)) return whole;
    const braced = stripStrayClosingBrace(String(inner));
    const trimmed = braced.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    // Multi-line content is already display-form; keep it untouched (the
    // stray-brace strip may have consumed the structural trailing newline,
    // so restore it to keep the closing $$ on its own line).
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
}: {
  children: string;
  className?: string;
  variant?: Variant;
  /** When set (chat variant only), python fences get a Run affordance. */
  codeRunner?: CodeRunner;
}) {
  const s = STYLES[variant];
  const cwd = codeRunner?.cwd;
  const openInspector = useUiStore((s) => s.openInspector);
  const handleFileLink = useCallback((href: string) => {
    if (!cwd) return;
    let path = href;
    // Strip ./ prefix and resolve absolute paths under the workspace root.
    const normalizedCwd = cwd.replace(/[\/]+$/, "");
    if (path.startsWith("./")) path = path.slice(2);
    else if (path.startsWith(normalizedCwd + "/") || path.startsWith(normalizedCwd + "\\")) path = path.slice(normalizedCwd.length + 1);
    openInspector(fileInspectorForPath(path, path.split(/[\\/]/).at(-1) || path, undefined, cwd));
  }, [cwd, openInspector]);
  return (
    <div className={cn(s.root, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={{
          p: ({ children }) => <p className={s.p}>{children}</p>,
          a: ({ children, href: rawHref }) => {
            const href = rawHref ?? "";
            if (cwd && FILE_HREF.test(href)) {
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
            return (
              <a href={rawHref} className={s.a}>
                {children}
              </a>
            );
          },
          code: ({ children }) => <code className={s.code}>{children}</code>,
          span: ({ children, className, node: _node, ...props }) => {
            if (className === "katex-display") {
              return <MathBlock variant={variant}>{children}</MathBlock>;
            }
            return (
              <span {...props} className={className}>
                {children}
              </span>
            );
          },
          // Block code: the plain wrapper — its inner <code> is restyled via [&_code].
          // In chat with a codeRunner, python fences become executable blocks.
          pre: ({ children }) => {
            const codeEl = Array.isArray(children) ? children[0] : children;
            if (codeRunner && variant === "chat" && isValidElement(codeEl)) {
              const codeProps = codeEl.props as { className?: string; children?: React.ReactNode };
              if (runnableLanguage(fenceLanguage(codeProps.className))) {
                return (
                  <RunnableCodeBlock code={reactText(codeProps.children)} cwd={codeRunner.cwd} sessionId={codeRunner.sessionId} preClassName={s.pre}>
                    {children}
                  </RunnableCodeBlock>
                );
              }
            }
            return <pre className={s.pre}>{children}</pre>;
          },
          ul: ({ children }) => <ul className={s.ul}>{children}</ul>,
          ol: ({ children }) => <ol className={s.ol}>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          // Document elements (headings, quotes, tables, rules) — Tailwind's
          // preflight strips the browser defaults, so each needs explicit style.
          h1: ({ children }) => <h1 className={s.h1}>{children}</h1>,
          h2: ({ children }) => <h2 className={s.h2}>{children}</h2>,
          h3: ({ children }) => <h3 className={s.h3}>{children}</h3>,
          h4: ({ children }) => <h4 className={s.h4}>{children}</h4>,
          blockquote: ({ children }) => <blockquote className={s.blockquote}>{children}</blockquote>,
          hr: () => <hr className={s.hr} />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className={s.table}>{children}</table>
            </div>
          ),
          th: ({ children }) => <th className={s.th}>{children}</th>,
          td: ({ children }) => <td className={s.td}>{children}</td>,
        }}
      >
        {normalizeMathInput(children)}
      </ReactMarkdown>
    </div>
  );
}
