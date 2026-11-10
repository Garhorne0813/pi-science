import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { useCitationCwd, useCitationEvidence, citationResolver, citationCardState, type CitationEvidence } from "../../lib/citations/citation-evidence";
import type { CitationNumbering, CitationSource } from "../../lib/citations";
import { cn } from "../../lib/ui";
import { CitationVerifyButton } from "./CitationVerifyButton";

/** The numbered reference list an answer ends with. It reads the same snapshot
 *  the body markers read, and it uses the numbers the body shows, so the two
 *  can never point at different sources. A row states what the lookup returned
 *  and nothing more: found metadata is not a judgement that the paper supports
 *  the claim, and a failed request is not a source that does not exist. */
export function CitationReferences({ numbering, text, streaming = false }: { numbering: CitationNumbering; text: string; streaming?: boolean }) {
  const { t } = useTranslation();
  const cwd = useCitationCwd();
  const { bySource, unprocessed } = useCitationEvidence(cwd, text, streaming);
  if (!numbering.sources.length) return null;
  return (
    <section className="mt-2 border-t border-border/70 pt-1.5" aria-label={t("conversation.references")}>
      <p className="text-[10px] text-muted">{t("conversation.references")} ({numbering.sources.length})</p>
      <ol className="mt-1 space-y-1">
        {/* The snapshot files a source under the version it was cited at, so the
            row reads it by that spelling rather than by the version-less id. */}
        {numbering.sources.map((source) => <CitationReferenceRow key={`${source.kind}:${source.requested_ids[0]}`} source={source} evidence={bySource.get(`${source.kind}:${source.requested_ids[0]}`)} />)}
      </ol>
      {unprocessed.length > 0 && <p className="mt-1 text-[10px] text-warn-text">{t("conversation.citationTooMany", { count: unprocessed.length })}</p>}
    </section>
  );
}

function CitationReferenceRow({ source, evidence }: { source: CitationSource; evidence: CitationEvidence | undefined }) {
  const { t } = useTranslation();
  const key = `${source.kind}:${source.requested_ids[0]}`;
  const resolver = citationResolver(key);
  const state = citationCardState(evidence);
  const detail = [
    evidence?.title ? t("conversation.citationEvidence", { title: evidence.title, year: evidence.year ?? "—" }) : source.requested_ids.join(", "),
    evidence?.retraction === "retracted" ? t("conversation.citationRetracted") : null,
    evidence?.bibliographic === "mismatch" ? t("conversation.citationBibliographicMismatch", { cited: evidence.bibliographic_note ?? "" }) : null,
    evidence?.status === "error" ? t("conversation.citationLookupFailed", { reason: evidence.error ?? "" }) : null,
    evidence?.status === "not_found" ? t("conversation.citationNotInSource", { providers: evidence.checked_providers.join(", ") || t("citation.card.noProviders") }) : null,
    evidence?.version === "unconfirmed" ? t("conversation.citationVersionUnconfirmed", { requested: evidence.requested_version ?? "—", current: evidence.record_version ?? "—" }) : null,
    evidence?.verified_at ? t("conversation.citationCheckedAt", { at: evidence.verified_at }) : null,
  ].filter((part): part is string => Boolean(part));
  const bibliographic = evidence?.title ? [evidence.authors?.slice(0, 3).join(", "), evidence.journal, evidence.year].filter(Boolean).join(" · ") : "";
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[10px] leading-4">
      <span className="font-mono text-muted">[{source.number}]</span>
      <a href={resolver?.url ?? "#"} target="_blank" rel="noreferrer" title={detail.join(" · ")} className="font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-accent">{source.requested_ids[0]}</a>
      {evidence?.title && <span className="text-text">{evidence.title}</span>}
      {bibliographic && <span className="text-muted">{bibliographic}</span>}
      {evidence?.retraction === "retracted" && <span aria-label={t("conversation.citationState.retracted")} className="rounded border border-error-text px-1 text-error-text">⚠</span>}
      {evidence?.bibliographic === "mismatch" && <span aria-label={t("conversation.citationState.mismatch")} className="rounded border border-warn-text px-1 text-warn-text">≠</span>}
      {state === "error" && <span aria-label={t("conversation.citationState.error")} className="rounded border border-warn-text px-1 text-warn-text">!</span>}
      {state === "not_found" && <span aria-label={t("conversation.citationState.not_found")} className="rounded border border-warn-text px-1 text-warn-text">?</span>}
      {evidence?.oa_url && <a href={evidence.oa_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">{t("citation.card.openFullText")}<ExternalLink size={9} /></a>}
      <CitationVerifyButton citationKey={key} hasEvidence={Boolean(evidence) && evidence?.status !== "unchecked"} className={cn("ml-auto")} />
    </li>
  );
}
