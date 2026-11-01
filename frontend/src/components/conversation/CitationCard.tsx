import { ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { citationCardState, citationResolver, useCitationCwd, useCitationSession, useVerifyCitation, type CitationCardState, type CitationEvidence } from "../../lib/citations/citation-evidence";
import { useCitationPosition, type CitationPosition } from "../../lib/citations/citation-passages";
import { formattedReference } from "../../lib/citations/citation-reference-format";
import { cn } from "../../lib/ui";
import { CitationSourceViewer, PassageBody, locatorLine } from "./CitationSourceViewer";
import { CitationVerifyButton } from "./CitationVerifyButton";

const STATE_KEY: Record<CitationCardState, string> = { unchecked: "unverified", checking: "checking", found: "found", not_found: "not_found", error: "error" };

/** Distance between the trigger and the card. The card's own `before:` bridge
 *  covers it (the class is `-bottom-2`/`-top-2` = 0.5rem), so the pointer
 *  travelling between the number and the card never crosses dead space. */
const ANCHOR_GAP = 8;
const VIEWPORT_MARGIN = 8;
/** `w-96`, so the width the placement clamps is the width the card renders at. */
const CARD_WIDTH = 384;
/** Below this much room above the trigger, the card opens downward instead. */
const MIN_SPACE_ABOVE = 180;

type Placement = { left: number; width: number; maxHeight: number; top?: number; bottom?: number; below: boolean };

/** Where the card goes, in viewport coordinates. A portal escapes the
 *  `overflow` of a scrolling table and the message container's own clipping,
 *  and it also escapes the virtualised thread's transforms, which would break a
 *  fixed child that stayed in place. The cost is that the placement has to be
 *  measured, and re-measured while the thread scrolls. */
function placementFor(rect: DOMRect): Placement {
  const width = Math.min(CARD_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), Math.max(window.innerWidth - width - VIEWPORT_MARGIN, VIEWPORT_MARGIN));
  const above = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN;
  const below = window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const openBelow = above < MIN_SPACE_ABOVE && below > above;
  const space = Math.max(openBelow ? below : above, 0);
  return openBelow
    ? { left, width, maxHeight: space, top: rect.bottom + ANCHOR_GAP, below: true }
    : { left, width, maxHeight: space, bottom: window.innerHeight - rect.top + ANCHOR_GAP, below: false };
}

/** One formatted reference with its own copy action. */
function FormattedReference({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch { /* the clipboard is unavailable outside a secure context */ }
  };
  return <div className="mt-1.5">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] font-medium text-muted">{label}</span>
      <button type="button" onClick={() => void copy()} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-accent">
        {copied ? t("citation.card.copied") : t("citation.card.copy")}
      </button>
    </div>
    <p className="mt-0.5 select-text text-[10px] leading-4 text-text">{text}</p>
  </div>;
}

/** Why there is no passage to show. Each state names what actually happened:
 *  a paper with no open full text, one we were not allowed to read, one that
 *  failed to download, one whose bytes held no readable text, and a citation
 *  pinned to a version whose text we do not hold. None of them is "the paper
 *  does not say this". */
function passageNotice(t: (key: string, options?: Record<string, unknown>) => string, position: CitationPosition | undefined, hasOpenFullText: boolean): { message: string; retryable: boolean } | null {
  if (position?.state === "matched" && position.excerpts.length) return null;
  switch (position?.state) {
    case "unfetched": return { message: t("citation.passage.unfetched"), retryable: true };
    case "no_match": return { message: t("citation.passage.noMatch"), retryable: true };
    case "access_denied": return { message: t("citation.passage.accessDenied"), retryable: false };
    case "download_failed": return { message: t("citation.passage.downloadFailed", { reason: position.note ?? "" }), retryable: true };
    case "parse_failed": return { message: t("citation.passage.parseFailed"), retryable: false };
    case "no_text_layer": return { message: t("citation.passage.noTextLayer"), retryable: false };
    case "version_mismatch": return { message: t("citation.passage.versionMismatch"), retryable: false };
    case "stale": return { message: t("citation.passage.stale"), retryable: false };
    case "available": return { message: t("citation.passage.noMatch"), retryable: true };
    case "no_open_fulltext": return { message: t("citation.passage.noOpenFullText"), retryable: false };
    default: return hasOpenFullText ? { message: t("citation.passage.unfetched"), retryable: true } : { message: t("citation.card.noFullText"), retryable: false };
  }
}

/** The source card. A hover previews the located passage; a click pins it and
 *  only then is the paper's full text fetched, so moving the pointer over an
 *  answer never spends a provider request. Opening and previewing read the
 *  workspace snapshot only; every provider request starts from the check button
 *  or from an explicit "show the source" action. */
export function CitationCard({ id, citationKey, claim = "", evidence, focusOnOpen, trigger, onPointerEnter, onPointerLeave, onClose }: {
  id: string;
  citationKey: string;
  /** The sentence the marker sits in. The same paper is cited by different
   *  sentences, and each sentence points at different text. Absent when the
   *  card is opened without a rendered sentence, which reads as no claim. */
  claim?: string;
  evidence: CitationEvidence | undefined;
  /** True when a click or the keyboard opened the card. A hover preview must
   *  never take focus away from the answer and must never fetch. */
  focusOnOpen: boolean;
  trigger: React.RefObject<HTMLElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const cwd = useCitationCwd();
  const session = useCitationSession();
  const verify = useVerifyCitation(cwd);
  const card = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<Placement>(() => placementFor(trigger.current?.getBoundingClientRect() ?? new DOMRect()));
  const [wantFullText, setWantFullText] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [excerptIndex, setExcerptIndex] = useState(0);
  const close = useRef(onClose);
  close.current = onClose;

  // A pinned card may fetch; a hover preview may not. Clicking "show the
  // source" from a preview upgrades this card to a fetching one.
  const allowFetch = focusOnOpen || wantFullText;
  const { position, isLoading } = useCitationPosition(cwd, session, claim.trim() ? { key: citationKey, claim } : null, allowFetch);
  const excerpts = position?.excerpts ?? [];
  const supplementary = position?.supplementary ?? [];
  // The heading names where the passage came from. A passage the model chose
  // while writing is a different fact from one found by reading the finished
  // sentence, and the card must not present the second as the first.
  const passageLabel = position?.origin === "generation" ? t("citation.passage.generation") : t("citation.passage.located");

  const measure = useCallback(() => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPlacement(placementFor(rect)); }, [trigger]);
  // Focus goes back to the number only when the card had it: a hover preview
  // closed by pointer movement must not move focus either.
  const dismiss = useCallback(() => { if (card.current?.contains(document.activeElement)) trigger.current?.focus(); close.current(); }, [trigger]);
  useLayoutEffect(measure, [measure]);
  // The thread scrolls under a fixed card, so the card follows its number
  // instead of staying glued to the viewport.
  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [measure]);
  useEffect(() => { if (focusOnOpen) closeButton.current?.focus(); }, [focusOnOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !viewerOpen) { event.stopPropagation(); dismiss(); } };
    // The card is a portal, so the number that opened it is outside it and has
    // to be named as inside here: clicking it pins the card, never closes it.
    // The source viewer is a second portal and belongs to this card too.
    const onClick = (event: MouseEvent) => {
      if (viewerOpen) return;
      const target = event.target as Node;
      if (card.current?.contains(target) || trigger.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("click", onClick); };
  }, [dismiss, trigger, viewerOpen]);

  const resolver = citationResolver(citationKey);
  const state = citationCardState(evidence, verify.isPending);
  const identifier = resolver?.id ?? citationKey;
  const sourceType = resolver ? t(`citation.card.sourceType.${resolver.kind}`) : "";
  const bibliographic = evidence?.title ? [evidence.authors?.slice(0, 6).join(", "), evidence.journal, evidence.year].filter(Boolean).join(" · ") : "";
  const serialNumber = evidence?.volume ? (evidence.issue ? `${evidence.volume}(${evidence.issue})` : evidence.volume) : evidence?.issue ?? null;
  const serial = [serialNumber, evidence?.pages].filter(Boolean).join(": ");
  const queried = evidence?.checked_providers?.length ? t("citation.card.queriedFrom", { providers: evidence.checked_providers.join(", "), at: evidence.verified_at }) : t("citation.card.neverQueried");
  const gbt = evidence ? formattedReference(evidence, "gbt7714") : null;
  const apa = evidence ? formattedReference(evidence, "apa") : null;
  const notice = passageNotice(t, position, Boolean(evidence?.oa_url));
  const excerpt = excerpts[Math.min(excerptIndex, excerpts.length - 1)];

  return createPortal(<div
    ref={card}
    id={id}
    role="dialog"
    aria-label={`${sourceType} ${identifier}`}
    onPointerEnter={onPointerEnter}
    onPointerLeave={() => { if (!viewerOpen) onPointerLeave(); }}
    style={{ position: "fixed", left: placement.left, width: placement.width, maxHeight: placement.maxHeight, ...(placement.below ? { top: placement.top } : { bottom: placement.bottom }) }}
    className={cn("ui-popover z-[70] flex flex-col rounded-card text-left", placement.below ? "before:-top-2" : "before:-bottom-2", "before:absolute before:inset-x-0 before:h-2 before:content-['']")}
  >
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex items-start justify-between gap-2">
        <span className={cn("inline-block rounded px-1.5 py-0.5 text-[10px] font-medium", state === "found" ? "bg-ok-fill text-white" : state === "error" || state === "not_found" ? "bg-warn-fill text-white" : "bg-surface-2 text-muted")}>
          {t(`conversation.citationState.${STATE_KEY[state]}`)}
        </span>
        <button ref={closeButton} data-card-close type="button" onClick={dismiss} aria-label={t("citation.card.close")} className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-text">
          <X size={12} />
        </button>
      </div>

      {/* The located passage is the card's main content: it is what the reader
          opened the card to check. Metadata sits below it. */}
      {excerpt
        ? <>
            <div className="mt-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-medium text-muted">{passageLabel}</span>
              {locatorLine(t, excerpt) && <span className="truncate font-mono text-[10px] text-muted">{locatorLine(t, excerpt)}</span>}
            </div>
            <div className="ui-card-inset mt-1 rounded-card p-2"><PassageBody excerpt={excerpt} className="line-clamp-6" /></div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => { setExcerptIndex(0); setViewerOpen(true); }} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:border-accent hover:underline">{t("citation.passage.viewSource")}</button>
              {excerpts.length > 1 && <span className="text-[10px] text-muted">{t("citation.passage.moreCandidates", { count: excerpts.length - 1 })}</span>}
            </div>
            <p className="mt-1 text-[10px] text-warn-text">{t("citation.passage.caveat")}</p>
          </>
        : <div className="mt-1.5">
            <p className="text-[10px] text-muted">{isLoading ? t("citation.passage.loading") : notice?.message}</p>
            {notice?.retryable && !isLoading && <button type="button" onClick={() => setWantFullText(true)} className="mt-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:border-accent hover:underline">{t("citation.passage.fetchFullText")}</button>}
          </div>}

      {/* A search of the same snapshot is a second opinion, not the evidence
          the answer used, so it stays folded and named as what it is. */}
      {supplementary.length > 0 && <details className="mt-2 rounded border border-border/60 px-1.5 py-1">
        <summary className="cursor-pointer text-[10px] text-muted hover:text-text">{t("citation.passage.supplementary", { count: supplementary.length })}</summary>
        <ul className="mt-1 space-y-1.5">
          {supplementary.map((candidate) => <li key={candidate.passage_id}>
            {locatorLine(t, candidate) && <p className="font-mono text-[10px] text-muted">{locatorLine(t, candidate)}</p>}
            <p className="line-clamp-3 select-text text-[10px] leading-4 text-text">{candidate.text}</p>
          </li>)}
        </ul>
        <p className="mt-1 text-[10px] text-muted">{t("citation.passage.supplementaryNote")}</p>
      </details>}

      <details className="mt-2 border-t border-border/60 pt-1.5">
        <summary className="cursor-pointer text-[10px] text-muted hover:text-text">{t("citation.passage.details")}</summary>
        <div className="mt-1 space-y-1 text-[11px] leading-4">
          <p className="font-mono text-[10px] text-muted"><span className="text-muted/70">{t("citation.card.identifier")} </span>{sourceType} · {identifier}</p>
          {evidence?.title && <p className="font-medium text-text">{evidence.title}</p>}
          {bibliographic && <p className="text-muted">{bibliographic}</p>}
          {serial && <p className="font-mono text-[10px] text-muted">{serial}</p>}
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

        {/* Named as an abstract everywhere it appears: an abstract is not the
            passage, and reading it as the passage would let a paper appear to
            say something its text does not. */}
        {evidence?.abstract && <>
          <details className="mt-1.5 text-[10px] text-muted">
            <summary className="cursor-pointer text-muted hover:text-text">{t("citation.card.abstract")}</summary>
            <p className="mt-1 leading-4">{evidence.abstract}</p>
          </details>
          <p className="mt-1 text-[10px] text-warn-text">{t("citation.card.abstractNote")}</p>
        </>}

        {gbt && <FormattedReference label={t("citation.card.gbt7714")} text={gbt} />}
        {apa && <FormattedReference label={t("citation.card.apa")} text={apa} />}

        <p className="mt-1.5 text-[10px] text-muted">{t("citation.card.bibliographicOnly")}</p>
      </details>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {resolver && <a href={resolver.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:underline">
          {resolver.kind === "doi" ? t("citation.card.openDoi") : t("citation.card.openArxiv")}<ExternalLink size={9} />
        </a>}
        {evidence?.oa_url && <a href={evidence.oa_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:underline">{t("citation.card.openFullText")}<ExternalLink size={9} /></a>}
        <CitationVerifyButton citationKey={citationKey} hasEvidence={Boolean(evidence) && evidence?.status !== "unchecked"} verify={verify} />
      </div>
      <p className="mt-1.5 text-[10px] text-muted/80">{t("conversation.citationCardNote")}</p>
    </div>
    {viewerOpen && excerpt && <CitationSourceViewer
      title={evidence?.title ?? identifier}
      label={passageLabel}
      excerpts={excerpts}
      excerptIndex={excerptIndex}
      onIndex={setExcerptIndex}
      resolverUrl={resolver?.url ?? null}
      onClose={() => setViewerOpen(false)}
      returnFocusTo={trigger.current}
    />}
  </div>, document.body);
}
