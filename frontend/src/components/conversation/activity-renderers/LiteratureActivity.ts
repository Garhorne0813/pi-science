import { count, detailRecord, genericDetails, text } from "./shared";
import type { ActivityRenderer } from "./types";

function literatureSource(tool: string, input: Record<string, unknown>): string {
  const explicit = text(input.database) ?? text(input.source);
  if (explicit) return explicit;
  const normalized = tool.toLowerCase();
  if (normalized.includes("pubmed")) return "PubMed";
  if (normalized.includes("crossref")) return "Crossref";
  if (normalized.includes("semantic_scholar")) return "Semantic Scholar";
  return "Literature";
}

export const LiteratureActivityRenderer: ActivityRenderer = {
  compact: ({ activity, source, t }) => {
    const details = detailRecord(source);
    const database = literatureSource(source.tool, source.input ?? {});
    const results = count(details.results) ?? count(details.resultCount) ?? count(details.result_count);
    const retained = count(details.retained) ?? count(details.selected) ?? count(details.retainedCount);
    const title = activity.state === "running"
      ? t("conversation.activity.literatureRunning", { database })
      : activity.state === "error"
        ? t("conversation.activity.literatureFailed", { database })
        : database;
    const detail = results === undefined
      ? undefined
      : retained === undefined
        ? t("conversation.activity.resultCount", { count: results })
        : t("conversation.activity.resultRetainedCount", { count: results, retained });
    return { title, ...(detail ? { detail } : {}) };
  },
  expanded: genericDetails,
};
