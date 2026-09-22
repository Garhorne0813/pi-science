import { count, detailRecord, genericDetails, meaningfulActivityTitle, record, text } from "./shared";
import type { ActivityRenderer } from "./types";

function displaySource(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized.includes("pubmed")) return "PubMed";
  if (normalized.includes("crossref")) return "Crossref";
  if (normalized.includes("semanticscholar")) return "Semantic Scholar";
  if (normalized.includes("arxiv")) return "arXiv";
  if (normalized.includes("medrxiv")) return "medRxiv";
  if (normalized.includes("biorxiv")) return "bioRxiv";
  if (normalized.includes("europepmc")) return "Europe PMC";
  if (normalized === "literature") return "Literature";
  return value.trim();
}

function literatureDetails(details: Record<string, unknown>): Record<string, unknown> {
  return record(details.structuredContent)
    ?? record(details.result)
    ?? details;
}

function literatureSource(tool: string, input: Record<string, unknown>, details: Record<string, unknown>): string {
  const request = record(details.request);
  // bioRxiv and medRxiv share one tool name; the requested server is the
  // authoritative provider even before a result envelope exists.
  const server = text(input.server) ?? text(request?.server) ?? text(details.server);
  const normalizedServer = server?.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalizedServer === "biorxiv" || normalizedServer === "medrxiv") return displaySource(server!);

  const explicit = text(input.database)
    ?? text(input.source)
    ?? text(input.provider)
    ?? text(request?.provider)
    ?? text(details.provider);
  if (explicit) return displaySource(explicit);

  const normalized = tool.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized.includes("pubmed")) return "PubMed";
  if (normalized.includes("crossref")) return "Crossref";
  if (normalized.includes("semantic")) return "Semantic Scholar";
  if (normalized.includes("arxiv")) return "arXiv";
  if (normalized.includes("medrxiv")) return "medRxiv";
  if (normalized.includes("biorxiv")) return "bioRxiv";
  if (normalized.includes("europepmc")) return "Europe PMC";
  return "Literature";
}

export const LiteratureActivityRenderer: ActivityRenderer = {
  compact: ({ activity, source, t }) => {
    const rawDetails = detailRecord(source);
    const details = literatureDetails(rawDetails);
    const database = literatureSource(source.tool, source.input ?? {}, details);
    const results = count(details.count)
      ?? count(details.records)
      ?? count(details.results)
      ?? count(details.resultCount)
      ?? count(details.result_count);
    const retained = count(details.retained) ?? count(details.selected) ?? count(details.retainedCount);
    const semanticTitle = meaningfulActivityTitle(activity.title, source.tool);
    const genericTitle = activity.state === "running"
      ? t("conversation.activity.literatureRunning", { database })
      : activity.state === "error"
        ? t("conversation.activity.literatureFailed", { database })
        : database;
    const title = semanticTitle ?? genericTitle;
    const detail = results === undefined
      ? undefined
      : retained === undefined
        ? t("conversation.activity.resultCount", { count: results })
        : t("conversation.activity.resultRetainedCount", { count: results, retained });
    const detailParts = semanticTitle
      ? [activity.state === "running"
        ? t("conversation.activity.literatureRunning", { database })
        : activity.state === "error"
          ? t("conversation.activity.literatureFailed", { database })
          : database]
      : [];
    if (detail) detailParts.push(detail);
    return { title, ...(detailParts.length > 0 ? { detail: detailParts.join(" · ") } : {}) };
  },
  expanded: genericDetails,
};
