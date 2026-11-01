import { ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { citationCardState, citationResolver, useCitationCwd, useVerifyCitation, type CitationCardState, type CitationEvidence } from "../../lib/citations/citation-evidence";
import { formattedReference } from "../../lib/citations/citation-reference-format";
import { cn } from "../../lib/ui";
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

/** The source card. A dialog, not a tooltip: it holds buttons, so it has to be
 *  focusable, reachable by keyboard and Escape-dismissable, and it has to work
 *  on touch where there is no hover. Opening it reads the workspace snapshot
 *  only; every provider request starts from the check button inside. */
export function CitationCard({ id, citationKey, evidence, focusOnOpen, trigger, onPointerEnter, onPointerLeave, onClose }: {
  id: string;
  citationKey: string;
  evidence: CitationEvidence | undefined;
  /** True when a click or the keyboard opened the card. A hover preview must
   *  never take focus away from the answer. */
  focusOnOpen: boolean;
  trigger: React.RefObject<HTMLElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const cwd = useCitationCwd();
  const verify = useVerifyCitation(cwd);
  const card = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<Placement>(() => placementFor(trigger.current?.getBoundingClientRect() ?? new DOMRect()));
  const close = useRef(onClose);
  close.current = onClose;

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
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } };
    // The card is a portal, so the number that opened it is outside it and has
    // to be named as inside here: clicking it pins the card, never closes it.
    const onClick = (event: MouseEvent) => { const target = event.target as Node; if (card.current?.contains(target) || trigger.current?.contains(target)) return; close.current(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("click", onClick); };
  }, [dismiss, trigger]);

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

  return createPortal(<div
    ref={card}
    id={id}
    role="dialog"
    aria-label={`${sourceType} ${identifier}`}
    onPointerEnter={onPointerEnter}
    onPointerLeave={onPointerLeave}
    style={{ position: "fixed", left: placement.left, width: placement.width, maxHeight: placement.maxHeight, ...(placement.below ? { top: placement.top } : { bottom: placement.bottom }) }}
    className={cn("ui-popover z-[70] flex flex-col rounded-card text-left", placement.below ? "before:-top-2" : "before:-bottom-2", "before:absolute before:inset-x-0 before:h-2 before:content-['']")}
  >
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex items-start justify-between gap-2">
        <span className={cn("inline-block rounded px-1.5 py-0.5 text-[10px] font-medium", state === "found" ? "bg-ok-fill text-ok-text" : state === "error" || state === "not_found" ? "bg-warn-fill text-warn-text" : "bg-surface-2 text-muted")}>
          {t(`conversation.citationState.${STATE_KEY[state]}`)}
        </span>
        <button ref={closeButton} data-card-close type="button" onClick={dismiss} aria-label={t("citation.card.close")} className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-text">
          <X size={12} />
        </button>
      </div>

      <div className="mt-1.5 space-y-1 text-[11px] leading-4">
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

      {evidence?.abstract && <>
        <details className="mt-1.5 text-[10px] text-muted">
          <summary className="cursor-pointer text-muted hover:text-text">{t("citation.card.abstract")}</summary>
          <p className="mt-1 leading-4">{evidence.abstract}</p>
        </details>
        {/* Outside the disclosure: the caveat has to be readable whether or not
            the preview is expanded. */}
        <p className="mt-1 text-[10px] text-warn-text">{t("citation.card.abstractNote")}</p>
      </>}

      {gbt && <FormattedReference label={t("citation.card.gbt7714")} text={gbt} />}
      {apa && <FormattedReference label={t("citation.card.apa")} text={apa} />}

      <p className="mt-1.5 text-[10px] text-muted">{t("citation.card.bibliographicOnly")}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {resolver && <a href={resolver.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:underline">
          {resolver.kind === "doi" ? t("citation.card.openDoi") : t("citation.card.openArxiv")}<ExternalLink size={9} />
        </a>}
        {evidence?.oa_url
          ? <a href={evidence.oa_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:underline">{t("citation.card.openFullText")}<ExternalLink size={9} /></a>
          : <span className="text-[10px] text-muted">{t("citation.card.noFullText")}</span>}
        <CitationVerifyButton citationKey={citationKey} hasEvidence={Boolean(evidence) && evidence?.status !== "unchecked"} verify={verify} />
      </div>
      <p className="mt-1.5 text-[10px] text-muted/80">{t("conversation.citationCardNote")}</p>
    </div>
  </div>, document.body);
}
