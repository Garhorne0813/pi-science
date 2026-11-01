import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { citationCardState, citationResolver, type CitationCardState, type CitationEvidence } from "../../lib/citations/citation-evidence";
import { cn } from "../../lib/ui";
import { CitationVerifyButton } from "./CitationVerifyButton";

const STATE_KEY: Record<CitationCardState, string> = { unchecked: "unverified", checking: "checking", found: "found", not_found: "not_found", error: "error" };

/** The source card. A dialog, not a tooltip: it holds buttons, so it has to be
 *  focusable, reachable by keyboard and Escape-dismissable, and it has to work
 *  on touch where there is no hover. Opening it reads the workspace snapshot
 *  only; every provider request starts from the check button inside. */
export function CitationCard({ id, citationKey, evidence, onClose }: { id: string; citationKey: string; evidence: CitationEvidence | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>("[data-card-close]")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close.current(); } };
    const onClick = (event: MouseEvent) => { if (card.current && !card.current.contains(event.target as Node)) close.current(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("click", onClick); };
  }, []);

  const resolver = citationResolver(citationKey);
  const state = citationCardState(evidence);
  const identifier = resolver?.id ?? citationKey;
  const sourceType = resolver ? t(`citation.card.sourceType.${resolver.kind}`) : "";
  const bibliographic = evidence?.title ? [evidence.authors?.slice(0, 6).join(", "), evidence.journal, evidence.year].filter(Boolean).join(" · ") : "";
  const queried = evidence?.checked_providers?.length ? t("citation.card.queriedFrom", { providers: evidence.checked_providers.join(", "), at: evidence.verified_at }) : t("citation.card.neverQueried");

  return <div
    ref={card}
    id={id}
    role="dialog"
    aria-label={`${sourceType} ${identifier}`}
    className="absolute bottom-full left-0 z-40 mb-2 w-96 max-w-[min(24rem,90vw)] rounded-card border border-border bg-surface p-3 text-left shadow-lg"
  >
    <div className="flex items-start justify-between gap-2">
      <span className={cn("inline-block rounded px-1.5 py-0.5 text-[10px] font-medium", state === "found" ? "bg-ok-fill text-ok-text" : state === "error" || state === "not_found" ? "bg-warn-fill text-warn-text" : "bg-surface-2 text-muted")}>
        {t(`conversation.citationState.${STATE_KEY[state]}`)}
      </span>
      <button data-card-close type="button" onClick={onClose} aria-label={t("citation.card.close")} className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-text">
        <X size={12} />
      </button>
    </div>

    <div className="mt-1.5 space-y-1 text-[11px] leading-4">
      <p className="font-mono text-[10px] text-muted"><span className="text-muted/70">{t("citation.card.identifier")} </span>{sourceType} · {identifier}</p>
      {evidence?.title && <p className="font-medium text-text">{evidence.title}</p>}
      {bibliographic && <p className="text-muted">{bibliographic}</p>}
      {evidence?.status === "error" && <p className="text-warn-text">{t("conversation.citationLookupFailed", { reason: evidence.error ?? "" })}</p>}
      {evidence?.status === "not_found" && <p className="text-warn-text">{t("conversation.citationNotInSource", { providers: evidence.checked_providers.join(", ") || t("citation.card.noProviders") })}</p>}
      {evidence?.status_note && <p className="text-muted">{evidence.status_note}</p>}
      <p className="text-muted">{queried}</p>
    </div>

    {evidence?.retraction === "retracted" && <p className="mt-1.5 rounded border border-error-text/40 px-1.5 py-1 text-[10px] text-error-text">
      {t("citation.card.retractionNotice", { note: evidence.retraction_note ?? "" })}
      {evidence.retraction_url && <a href={evidence.retraction_url} target="_blank" rel="noreferrer" className="ml-1 underline">{t("citation.card.openDoi")}</a>}
    </p>}
    {evidence?.retraction === "unknown" && state !== "unchecked" && <p className="mt-1.5 text-[10px] text-muted">{t("citation.card.retractionUnknown")}</p>}
    {evidence?.bibliographic === "mismatch" && <p className="mt-1.5 text-[10px] text-warn-text">{t("conversation.citationBibliographicMismatch", { cited: evidence.bibliographic_note ?? "" })}</p>}
    {evidence?.version === "unconfirmed" && <p className="mt-1.5 text-[10px] text-warn-text">{t("citation.card.version", { requested: evidence.requested_version ?? "—", current: evidence.record_version ?? "—" })}</p>}
    <p className="mt-1.5 text-[10px] text-muted">{t("citation.card.bibliographicOnly")}</p>

    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {resolver && <a href={resolver.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:underline">
        {resolver.kind === "doi" ? t("citation.card.openDoi") : t("citation.card.openArxiv")}<ExternalLink size={9} />
      </a>}
      {evidence?.oa_url
        ? <a href={evidence.oa_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:underline">{t("citation.card.openFullText")}<ExternalLink size={9} /></a>
        : <span className="text-[10px] text-muted">{t("citation.card.noFullText")}</span>}
      <CitationVerifyButton citationKey={citationKey} hasEvidence={Boolean(evidence) && evidence?.status !== "unchecked"} />
    </div>
    <p className="mt-1.5 text-[10px] text-muted/80">{t("conversation.citationCardNote")}</p>
  </div>;
}
