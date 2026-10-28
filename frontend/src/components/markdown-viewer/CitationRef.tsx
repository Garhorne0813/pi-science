import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@/lib/client/api";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { cn } from "@/lib/ui";

interface CitationEvidence {
  kind: "doi" | "arxiv";
  id: string;
  status: "found" | "not_found";
  title: string | null;
  authors: string[];
  journal: string | null;
  year: string | null;
  abstract: string | null;
  oa_url: string | null;
  retracted: boolean;
}

/**
 * Inline citation with a verified-evidence hover. The link text stays exactly
 * what the model wrote (underlined with a dotted stroke); hovering loads the
 * cached evidence snapshot on demand — never the live providers.
 */
export function CitationRef({ href, citationKey, children }: { href: string; citationKey?: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const cwd = useRuntimeStore((state) => state.cwd);
  const [hovered, setHovered] = useState(false);

  const { data } = useQuery({
    queryKey: ["citation", cwd, citationKey],
    queryFn: () => apiRequest<{ citations: CitationEvidence[] }>(`/api/citations?${new URLSearchParams({ cwd, ids: citationKey ?? "" })}`),
    enabled: hovered && Boolean(cwd) && Boolean(citationKey),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const evidence = data?.citations?.[0];

  return (
    <span
      className="group/citation relative inline-block"
      onMouseEnter={() => setHovered(true)}
      onFocus={() => setHovered(true)}
    >
      <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted decoration-1 underline-offset-2 hover:text-accent">
        {children}
      </a>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute bottom-full left-0 z-40 mb-2 w-80 max-w-[min(20rem,80vw)] rounded-card border border-border bg-surface p-3 text-left opacity-0 shadow-lg transition-opacity",
          "group-hover/citation:visible group-hover/citation:opacity-100 group-focus-within/citation:visible group-focus-within/citation:opacity-100",
        )}
      >
        {!evidence && <span className="block text-xs text-muted">{t("citation.hoverUnverified")}</span>}
        {evidence && (
          <span className="block space-y-1">
            <span className={cn("inline-block rounded px-1.5 py-0.5 text-[10px] font-medium", evidence.retracted ? "bg-error-fill text-error-text" : evidence.status === "found" ? "bg-ok-fill text-ok-text" : "bg-warn-fill text-warn-text")}>
              {evidence.retracted ? t("citation.hoverRetracted") : evidence.status === "found" ? t("citation.hoverVerified") : t("citation.hoverNotFound")}
            </span>
            {evidence.title && <span className="block text-xs font-medium text-text">{evidence.title}</span>}
            {(evidence.authors?.length || evidence.year || evidence.journal) && (
              <span className="block text-[11px] text-muted">
                {[evidence.authors?.slice(0, 4).join(", "), evidence.journal, evidence.year].filter(Boolean).join(" · ")}
              </span>
            )}
            {evidence.abstract && <span className="block text-[11px] leading-4 text-muted">{evidence.abstract.slice(0, 160)}{evidence.abstract.length > 160 ? "…" : ""}</span>}
            {evidence.oa_url && <span className="block truncate text-[11px] text-accent">{evidence.oa_url}</span>}
          </span>
        )}
      </span>
    </span>
  );
}
