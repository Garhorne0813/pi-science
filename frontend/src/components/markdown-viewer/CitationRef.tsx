import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { citationResolver, useCitationCwd, useCitationInlineStyle, useCitationSource } from "@/lib/citations/citation-evidence";
import { claimForTrigger } from "@/lib/citations/citation-claim";
import { citationNumberForKey } from "@/lib/citations/numbering";
import { cn } from "@/lib/ui";
import { CitationCard } from "@/components/conversation/CitationCard";
import { useCitationNumbering } from "./CitationNumbering";

/** A preview closes this long after the pointer leaves, which is long enough to
 *  cross the gap onto the card; entering the card cancels it. */
const PREVIEW_CLOSE_MS = 180;
/** The identifier the model wrote, optionally written with its scheme. */
const IDENTIFIER_PREFIX = /^(?:doi|arxiv)\s*:\s*/i;

function textOf(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/** A link whose text is nothing but the identifier names no content of its own,
 *  so the body can read as the number instead. A link with words in it keeps
 *  its words: rewriting them would lose what the model meant. */
function isIdentifierOnly(text: string, id: string): boolean {
  return text.replace(IDENTIFIER_PREFIX, "").trim().toLowerCase() === id.toLowerCase();
}

/**
 * An inline citation. Opening the card reads the workspace snapshot and nothing
 * else; only the check button inside contacts a provider. Under the `number`
 * style a link that is just the identifier reads as the document's own number,
 * and a link with meaningful words keeps them and gains the number beside it.
 */
export function CitationRef({ href, citationKey, children }: { href: string; citationKey?: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const cwd = useCitationCwd();
  const numbering = useCitationNumbering();
  const style = useCitationInlineStyle(cwd);
  const number = numbering && citationKey ? citationNumberForKey(numbering, citationKey) : null;
  const [open, setOpen] = useState<"none" | "preview" | "pinned">("none");
  // The sentence is measured from the rendered answer when the card opens, not
  // on every render: reading the DOM on each pointer move would be wasted work
  // and would follow the answer if it re-renders mid-hover.
  const [claim, setClaim] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const cardId = `citation-card-${useId().replace(/:/g, "")}`;
  const evidence = useCitationSource(cwd, citationKey, open !== "none");
  const reveal = (next: "preview" | "pinned") => { setClaim(claimForTrigger(trigger.current)); setOpen(next); };

  const cancelClose = () => { if (closeTimer.current !== undefined) { window.clearTimeout(closeTimer.current); closeTimer.current = undefined; } };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => { closeTimer.current = undefined; setOpen("none"); }, PREVIEW_CLOSE_MS);
  };
  const close = () => { cancelClose(); setOpen("none"); };
  useEffect(() => cancelClose, []);

  // A click pins what a hover only previewed; a second click on the number
  // closes it. Pointer movement never closes a pinned card.
  const pin = () => {
    cancelClose();
    if (open === "pinned") { trigger.current?.focus(); setOpen("none"); return; }
    reveal("pinned");
  };
  const resolver = citationKey ? citationResolver(citationKey) : null;
  const text = textOf(children).trim();
  const numberAsText = style === "number" && number !== null && Boolean(resolver) && isIdentifierOnly(text, resolver?.id ?? "");
  const markerClass = "rounded px-0.5 font-mono text-[10px] align-super text-accent hover:bg-accent/10";

  return (
    <span
      className="inline-block"
      onPointerEnter={(event) => {
        if (event.pointerType === "touch" || !number || !citationKey) return;
        cancelClose();
        if (open === "none") reveal("preview");
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        if (open === "preview") scheduleClose();
      }}
    >
      {numberAsText && citationKey
        ? <a
            ref={(element) => { trigger.current = element; }}
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-haspopup="dialog"
            aria-expanded={open !== "none"}
            aria-controls={cardId}
            aria-label={t("conversation.references") + ` [${number}]`}
            onClick={(event) => {
              // The resolver stays reachable through the card and through the
              // browser's own link actions; a plain click opens the source.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              pin();
            }}
            className={cn(markerClass, open !== "none" && "bg-accent/10")}
          >[{number}]</a>
        : <>
            <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted decoration-1 underline-offset-2 hover:text-accent">{children}</a>
            {number !== null && citationKey && <button
              ref={(element) => { trigger.current = element; }}
              type="button"
              aria-expanded={open !== "none"}
              aria-controls={cardId}
              aria-haspopup="dialog"
              aria-label={t("conversation.references") + ` [${number}]`}
              onClick={pin}
              className={cn("ml-1", markerClass, open !== "none" && "bg-accent/10")}
            >[{number}]</button>}
          </>}
      {open !== "none" && number !== null && citationKey && <CitationCard
        id={cardId}
        citationKey={citationKey}
        claim={claim}
        evidence={evidence}
        focusOnOpen={open === "pinned"}
        trigger={trigger}
        onPointerEnter={cancelClose}
        onPointerLeave={() => { if (open === "preview") scheduleClose(); }}
        onClose={close}
      />}
    </span>
  );
}
