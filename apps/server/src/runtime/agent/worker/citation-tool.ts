/**
 * Agent tool for citation verification. The control plane resolves each DOI /
 * arXiv id against free public APIs and returns evidence (metadata, abstract,
 * open-access link, retraction status); the conversation model — the session's
 * own model — judges whether each citation actually supports the claim it is
 * attached to and reports that judgement in its reply.
 */
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;

const INTERNAL_TOKEN_HEADER = "x-pi-science-internal-token";

function backendBaseUrl(): string {
  return (process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

export function citationVerifyTool(cwd: string): Tool {
  return {
    name: "verify_citations",
    label: "Verify citations",
    description: "Verify every DOI and arXiv citation in a text against public scholarly APIs (Crossref, Unpaywall, arXiv). Returns per-citation evidence: title, authors, journal, year, abstract, open-access link and retraction status. Use it on your own report drafts before presenting them: for each citation, compare the evidence with the claim it supports and state clearly whether the source supports the claim, does not support it, or could not be verified. Never present a citation as verified when the evidence says otherwise.",
    parameters: Type.Object({
      text: Type.String({ description: "The text whose citations should be verified (typically your draft report or a section of it)" }),
    }),
    async execute(_toolCallId, params, _update, _ctx, _invocation, context) {
      const input = params as { text: string };
      const headers = new Headers({ "content-type": "application/json" });
      const token = process.env.PI_SCIENCE_INTERNAL_TOKEN;
      if (token) headers.set(INTERNAL_TOKEN_HEADER, token);
      const response = await fetch(`${backendBaseUrl()}/api/citations/verify?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: input.text }),
        signal: context.abortSignal,
      });
      const body = (await response.json().catch(() => ({}))) as { citations?: unknown[]; error?: string };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Citation verification returned HTTP ${response.status}`);
      const citations = Array.isArray(body.citations) ? (body.citations as Array<Record<string, unknown>>) : [];
      if (!citations.length) {
        return { content: [{ type: "text", text: "No DOI or arXiv citations were found in the text." }], details: { citations: 0 } };
      }
      const lines = citations.map((citation) => {
        const status = citation.status === "found" ? "found" : "NOT FOUND";
        const retracted = citation.retracted ? ` ⚠ RETRACTED (${String(citation.retraction_note ?? "retraction notice linked")})` : "";
        const authors = Array.isArray(citation.authors) && citation.authors.length ? (citation.authors as string[]).slice(0, 4).join(", ") : "unknown authors";
        const parts = [
          `[${status}] ${citation.kind}:${citation.id}${retracted}`,
          citation.title ? `title: ${String(citation.title)}` : null,
          `authors: ${authors}`,
          citation.journal ? `journal: ${String(citation.journal)}` : null,
          citation.year ? `year: ${String(citation.year)}` : null,
          citation.oa_url ? `open access: ${String(citation.oa_url)}` : null,
          citation.abstract ? `abstract: ${String(citation.abstract).slice(0, 1_200)}` : "abstract: unavailable",
          String(citation.retraction_note ?? "").startsWith("verification request failed") ? String(citation.retraction_note) : null,
        ].filter((line): line is string => line !== null);
        return parts.join("\n");
      });
      const guidance = [
        "For each citation above, judge whether its evidence supports the claim it is attached to:",
        "- supports: the abstract/metadata clearly backs the claim",
        "- does not support: the claim goes beyond or contradicts the evidence",
        "- unverified: status is NOT FOUND or the provider request failed",
        "State this judgement per citation in your reply and flag retracted sources prominently.",
      ].join("\n");
      return { content: [{ type: "text", text: `${lines.join("\n\n---\n\n")}\n\n${guidance}` }], details: { citations: citations.length } };
    },
  };
}
