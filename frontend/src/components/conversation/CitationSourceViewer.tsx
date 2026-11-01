import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CitationExcerpt } from "../../lib/citations/citation-passages";
import { cn } from "../../lib/ui";
import { Modal } from "../ui/Modal";

/** One passage, with the text either side of it that the lookup did not rank.
 *  The excerpt is highlighted and the context is dimmed, so a reader can see
 *  where the sentence sits instead of reading an isolated line. */
export function PassageBody({ excerpt, className }: { excerpt: CitationExcerpt; className?: string }) {
  return <p className={cn("select-text text-[11px] leading-5 text-text", className)}>
    {excerpt.before && <span className="text-muted">{excerpt.before}</span>}
    <mark className="rounded-sm bg-accent/20 px-0.5 text-text">{excerpt.text}</mark>
    {excerpt.after && <span className="text-muted">{excerpt.after}</span>}
  </p>;
}

/** Where the passage lives, in words a reader can act on. A page number is the
 *  PDF file's own sequence, so it is labelled as a file page rather than as the
 *  journal's printed page, which the two do not have to agree on. */
export function locatorLine(t: (key: string, options?: Record<string, unknown>) => string, excerpt: CitationExcerpt): string | null {
  const parts = [excerpt.section_title, excerpt.page === null ? null : t("citation.passage.filePage", { page: excerpt.page })].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The full-text viewer. It shows the located passage with its surrounding
 *  context and, when the source can be opened directly, a way there. It never
 *  claims the passage supports the claim: locating text and judging support are
 *  different jobs and the caveat says so. */
export function CitationSourceViewer({ title, label, excerpts, excerptIndex, onIndex, resolverUrl, onClose, returnFocusTo }: {
  title: string;
  /** Where these passages came from. The viewer says it the same way the card
   *  does, so opening the source does not relabel a chosen passage as a found
   *  one or the reverse. */
  label?: string;
  excerpts: CitationExcerpt[];
  excerptIndex: number;
  onIndex: (index: number) => void;
  resolverUrl: string | null;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const [focusKept] = useState(returnFocusTo);
  const index = Math.min(Math.max(excerptIndex, 0), Math.max(excerpts.length - 1, 0));
  const excerpt = excerpts[index];

  return <Modal title={title} onClose={onClose} restoreFocusTo={focusKept} contentClassName="w-[min(720px,calc(100vw-32px))]">
    {!excerpt && <p className="text-ui-body text-muted">{t("citation.passage.noMatch")}</p>}
    {excerpt && <>
      {excerpts.length > 1 && <div className="mb-2 flex items-center gap-1.5" role="tablist" aria-label={t("citation.passage.candidates")}>
        {excerpts.map((_, position) => <button
          key={position}
          type="button"
          role="tab"
          aria-selected={position === index}
          onClick={() => onIndex(position)}
          className={cn("rounded border px-1.5 py-0.5 text-[10px]", position === index ? "border-accent text-accent" : "border-border text-muted hover:border-accent hover:text-accent")}
        >{t("citation.passage.candidate", { index: position + 1 })}</button>)}
      </div>}
      <p className="text-[10px] font-medium text-muted">{label ?? t("citation.passage.located")}</p>
      {locatorLine(t, excerpt) && <p className="mt-0.5 font-mono text-[10px] text-muted">{locatorLine(t, excerpt)}</p>}
      <div className="ui-card-inset mt-1.5 rounded-card p-2.5"><PassageBody excerpt={excerpt} /></div>
      <p className="mt-1.5 text-[10px] text-warn-text">{t("citation.passage.caveat")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {resolverUrl && <a href={resolverUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-accent hover:underline">
          {t("citation.passage.openSource")}<ExternalLink size={9} />
        </a>}
        <button type="button" onClick={onClose} className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-accent">{t("citation.passage.back")}</button>
      </div>
    </>}
  </Modal>;
}
