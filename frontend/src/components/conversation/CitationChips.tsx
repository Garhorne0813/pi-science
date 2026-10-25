import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Citation } from "../../lib/citations";
import { apiRequest } from "../../lib/client/api";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { cn } from "../../lib/ui";

interface CitationEvidence {
  kind: "doi" | "arxiv";
  id: string;
  status: "found" | "not_found";
  title: string | null;
  authors: string[];
  journal: string | null;
  year: string | null;
  retracted: boolean;
  verified_at: string;
}

type VerifyState = "verified" | "retracted" | "not_found" | "unverified";

/** Chat source chips with verification state from the citation evidence
 *  snapshots: ✓ resolved, ⚠ retracted, ? unresolved, plain = not yet verified. */
export function CitationChips({ citations }: { citations: Citation[] }) {
  const { t } = useTranslation();
  const cwd = useRuntimeStore((state) => state.cwd);
  const ids = citations.map((citation) => `${citation.kind}:${citation.id}`);
  const { data } = useQuery({
    queryKey: ["citations", cwd, ...ids],
    queryFn: () => apiRequest<{ citations: CitationEvidence[] }>(`/api/citations?${new URLSearchParams({ cwd, ids: ids.join(",") })}`),
    enabled: Boolean(cwd) && citations.length > 0,
    staleTime: 60_000,
    retry: false,
  });

  const evidenceByKey = new Map((data?.citations ?? []).map((row) => [`${row.kind}:${row.id}`, row]));
  const stateFor = (citation: Citation): VerifyState => {
    const evidence = evidenceByKey.get(`${citation.kind}:${citation.id}`);
    if (!evidence) return "unverified";
    if (evidence.retracted) return "retracted";
    if (evidence.status === "found") return "verified";
    return "not_found";
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-muted">{t("conversation.sources")} ({citations.length})</span>
      {citations.map((citation, index) => {
        const state = stateFor(citation);
        const evidence = evidenceByKey.get(`${citation.kind}:${citation.id}`);
        const hover = evidence?.title
          ? t("conversation.citationEvidence", { title: evidence.title, year: evidence.year ?? "—" })
          : citation.id;
        const marker = state === "verified" ? "✓" : state === "retracted" ? "⚠" : state === "not_found" ? "?" : "";
        return (
          <a
            key={`${citation.kind}:${citation.id}`}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            title={state === "retracted" ? `${hover} — ${t("conversation.citationRetracted")}` : hover}
            className={cn(
              "rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted hover:text-text",
              state === "retracted" && "border-error-text text-error-text",
              state === "not_found" && "border-warn-text text-warn-text",
            )}
          >
            {index + 1} · {shortId(citation.id)}{marker && <span className="ml-1" aria-label={t(`conversation.citationState.${state}`)}>{marker}</span>}
          </a>
        );
      })}
    </div>
  );
}

function shortId(id: string): string { return id.length <= 24 ? id : `${id.slice(0, 14)}…${id.slice(-8)}`; }
