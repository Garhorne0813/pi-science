import { useTranslation } from "react-i18next";
import type { CitationLocator, CitationSourceStatus } from "@pi-science/contracts";
import { cn } from "../../lib/ui";
import { useUiStore } from "../../lib/ui";
import { citationSourceContentVisible, type ResolvedCitation } from "../../lib/citations/resolve";

const STATUS_TONE: Partial<Record<CitationSourceStatus, string>> = {
  changed: "text-warn-text",
  missing: "text-error-text",
  forbidden: "text-error-text",
  unavailable: "text-muted",
};

function baseNameOf(identity: string): string {
  return identity.split("/").pop() || identity;
}

function externalHref(citation: ResolvedCitation): string | null {
  const { kind, identity } = citation.token;
  if (kind === "doi") return `https://doi.org/${identity}`;
  if (kind === "arxiv") return `https://arxiv.org/abs/${identity}`;
  return kind === "web" ? identity : null;
}

function locatorLabel(locator: CitationLocator, t: (key: string, options?: Record<string, unknown>) => string): string | null {
  if (locator.kind === "lines") return t("conversation.citation.locator.lines", { start: locator.startLine, end: locator.endLine });
  if (locator.kind === "chars") return t("conversation.citation.locator.chars", { start: locator.start, end: locator.end });
  return null;
}

function capturedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function CitationCard({ citation, cwd }: { citation: ResolvedCitation; cwd?: string }) {
  const { t } = useTranslation();
  const openInspector = useUiStore((state) => state.openInspector);
  const { token, source } = citation;
  const title = source?.title ?? token.identity;
  const href = externalHref(citation);
  const tone = source ? STATUS_TONE[source.status] : undefined;
  const hasEvidence = Boolean(source && source.status !== "identifier-only");
  const showContent = citationSourceContentVisible(source);
  const locator = hasEvidence && source ? locatorLabel(source.locator, t) : null;
  const openFile = () => {
    if (!source) return;
    const filename = baseNameOf(source.identity);
    openInspector(/\.pdf$/i.test(source.identity)
      ? { variant: "pdf", path: source.identity, filename }
      : { variant: "file", path: source.identity, filename, ...(cwd ? { cwd } : {}) });
  };
  return <div className="flex flex-col gap-1 rounded-input border border-border bg-surface-2 px-2.5 py-1.5">
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="font-mono text-[10px] text-muted">{citation.index}</span>
      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted">{t(`conversation.citation.kind.${token.kind}`)}</span>
      {href
        ? <a href={href} target="_blank" rel="noreferrer" title={token.identity} className="min-w-0 truncate text-xs text-text hover:underline">{title}</a>
        : <span className="min-w-0 truncate text-xs text-text" title={token.identity}>{title}</span>}
      {tone && source && <span className={cn("text-[10px]", tone)}>{t(`conversation.citation.status.${source.status}`)}</span>}
      {token.kind === "file" && showContent && <button type="button" onClick={openFile} className="text-[10px] text-accent hover:underline">{t("conversation.citation.openSource")}</button>}
    </div>
    {showContent && source?.excerpt && <p className="line-clamp-3 text-[11px] leading-5 text-muted">{source.excerpt}</p>}
    {hasEvidence && source?.statusDetail && <p className="text-[10px] text-muted">{source.statusDetail}</p>}
    <div className="flex flex-wrap gap-2 text-[10px] text-muted">
      {locator && <span>{locator}</span>}
      {hasEvidence && source?.capturedAt && <span>{t("conversation.citation.capturedAt", { time: capturedLabel(source.capturedAt) })}</span>}
      {!hasEvidence && <span>{t("conversation.citation.noEvidence")}</span>}
    </div>
  </div>;
}

/** Sources an answer cited: identifiers always, workspace files and web pages
 *  only when the server captured the read that produced them. */
export function CitationSources({ citations, cwd }: { citations: ResolvedCitation[]; cwd?: string; sessionId?: string }) {
  const { t } = useTranslation();
  if (citations.length === 0) return null;
  return <div className="mt-2 flex flex-col gap-1.5" aria-label={t("conversation.sources")}>
    <span className="text-[10px] text-muted">{t("conversation.sources")} ({citations.length})</span>
    <div className="flex flex-col gap-1">
      {citations.map((citation) => <CitationCard key={`${citation.token.kind}:${citation.token.identity}`} citation={citation} cwd={cwd} />)}
    </div>
  </div>;
}
