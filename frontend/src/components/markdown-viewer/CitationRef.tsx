import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@/lib/client/api";
import { useCitationCwd, type CitationEvidence } from "@/lib/citations/citation-evidence";
import { citationNumberForKey } from "@/lib/citations/numbering";
import { cn } from "@/lib/ui";
import { CitationCard } from "@/components/conversation/CitationCard";
import { useCitationNumbering } from "./CitationNumbering";

/**
 * An inline citation. The identifier the model wrote stays written and stays a
 * link to the source; the number beside it comes from the document's own
 * numbering, and clicking the number opens the source card. Nothing here is
 * rewritten into a bare `[n]`, because the answer may be discussing the
 * identifier itself.
 */
export function CitationRef({ href, citationKey, children }: { href: string; citationKey?: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const cwd = useCitationCwd();
  const numbering = useCitationNumbering();
  const number = numbering && citationKey ? citationNumberForKey(numbering, citationKey) : null;
  const [open, setOpen] = useState<"none" | "preview" | "pinned">("none");
  const cardId = `citation-card-${useId().replace(/:/g, "")}`;

  // The card answers "what is already known about this source". Reading the
  // workspace snapshot contacts nobody; only the check button inside does.
  const { data } = useQuery({
    queryKey: ["citation", cwd, citationKey],
    queryFn: () => apiRequest<{ citations: CitationEvidence[] }>(`/api/citations?${new URLSearchParams({ cwd, ids: citationKey ?? "" })}`),
    enabled: open !== "none" && Boolean(cwd) && Boolean(citationKey),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const close = () => { setOpen("none"); document.getElementById(`${cardId}-trigger`)?.focus(); };

  return (
    <span
      className="group/citation relative inline-block"
      onPointerEnter={(event) => { if (event.pointerType !== "touch") setOpen((current) => current === "none" ? "preview" : current); }}
      onPointerLeave={() => setOpen((current) => current === "preview" ? "none" : current)}
    >
      <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted decoration-1 underline-offset-2 hover:text-accent">
        {children}
      </a>
      {number !== null && citationKey && <>
        <button
          id={`${cardId}-trigger`}
          type="button"
          aria-expanded={open !== "none"}
          aria-controls={cardId}
          aria-haspopup="dialog"
          aria-label={t("conversation.references") + ` [${number}]`}
          onClick={() => setOpen((current) => current === "pinned" ? "none" : "pinned")}
          className={cn("ml-1 rounded px-1 align-super font-mono text-[10px] text-accent hover:bg-accent/10", open !== "none" && "bg-accent/10")}
        >
          [{number}]
        </button>
        {open !== "none" && <CitationCard id={cardId} citationKey={citationKey} evidence={data?.citations?.[0]} onClose={close} />}
      </>}
    </span>
  );
}
