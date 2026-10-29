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
    description: "Look up the DOI and arXiv citations in a text in public scholarly APIs (Crossref, Unpaywall, arXiv). Returns per-citation evidence: title, authors, journal, year, abstract, open-access link, retraction state and a `version` state for arXiv. A found record means the source lists this identifier; it does NOT mean the paper supports the sentence that cites it. A `bibliographic` state compares the reference entry the text printed with the record: MISMATCH means the title in the text belongs to another paper, and `not_compared` means the text states no title for that identifier. Only DOI and arXiv identifiers are checked: PMIDs, bare titles and attachment-only citations are not checked, so never report an answer as fully verified. For each citation, compare the returned evidence with the claim it supports and say plainly whether the source supports the claim, does not support it, or could not be checked.",
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
        body: JSON.stringify({ text: input.text, trigger: "agent" }),
        signal: context.abortSignal,
      });
      const body = (await response.json().catch(() => ({}))) as { citations?: unknown[]; total?: number; processed?: number; unprocessed?: unknown[]; error?: string };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Citation verification returned HTTP ${response.status}`);
      const citations = Array.isArray(body.citations) ? (body.citations as Array<Record<string, unknown>>) : [];
      if (!citations.length) {
        return { content: [{ type: "text", text: "No DOI or arXiv citations were found in the text. PMIDs, bare titles and citations that only appear in attachments are not checked." }], details: { citations: 0 } };
      }
      const lines = citations.map((citation) => {
        const status = citation.status === "found" ? "SOURCE METADATA FOUND"
          : citation.status === "error" ? `LOOKUP FAILED (${String(citation.error ?? "provider error")})`
            : citation.status === "unchecked" ? "NOT CHECKED (automatic citation verification is off)"
              : `NOT IN ${(Array.isArray(citation.checked_providers) ? (citation.checked_providers as string[]) : []).join(", ") || "queried source"}${citation.status_note ? ` — ${String(citation.status_note)}` : ""}`;
        const bibliographic = citation.status !== "found" ? null
          : citation.bibliographic === "mismatch" ? `bibliographic check: MISMATCH — the reference entry in the answer does not match this record: "${String(citation.bibliographic_note ?? "")}"`
            : citation.bibliographic === "match" ? "bibliographic check: the reference entry in the answer matches this record"
              : "bibliographic check: not compared (the answer states no title for this identifier)";
        const retraction = citation.retraction === "retracted"
          ? ` ⚠ RETRACTION NOTICE (${String(citation.retraction_note ?? "linked")})${citation.retraction_url ? ` ${String(citation.retraction_url)}` : ""}`
          : citation.retraction === "unknown" ? ` retraction: unknown${citation.retraction_note ? ` (${String(citation.retraction_note)})` : ""}` : " retraction: no notice in queried sources";
        const version = citation.version === "unconfirmed"
          ? `\ncited version: ${String(citation.requested_version ?? "not stated")}; current version: ${String(citation.record_version ?? "unknown")} — the cited text is not confirmed`
          : "";
        const authors = Array.isArray(citation.authors) && citation.authors.length ? (citation.authors as string[]).slice(0, 4).join(", ") : "unknown authors";
        const parts = [
          `[${status}] ${citation.kind}:${String(citation.requested_id ?? citation.id)}${retraction}`,
          citation.title ? `title: ${String(citation.title)}` : null,
          `authors: ${authors}`,
          citation.journal ? `journal: ${String(citation.journal)}` : null,
          citation.year ? `year: ${String(citation.year)}` : null,
          citation.oa_url ? `open access: ${String(citation.oa_url)}` : null,
          citation.abstract ? `abstract: ${String(citation.abstract).slice(0, 1_200)}` : "abstract: unavailable",
          version || null,
          bibliographic,
        ].filter((line): line is string => line !== null);
        return parts.join("\n");
      });
      const total = typeof body.total === "number" ? body.total : citations.length;
      const unprocessed = Array.isArray(body.unprocessed) ? (body.unprocessed as Array<Record<string, unknown>>) : [];
      const coverage = unprocessed.length
        ? `Checked ${citations.length} of ${total} citations. NOT checked (over the 30-per-call limit): ${unprocessed.map((ref) => `${String(ref.kind)}:${String(ref.requested_id ?? ref.id)}`).join(", ")}. Do not report these as verified.`
        : `Checked ${citations.length} of ${total} citations.`;
      const unchecked = citations.filter((citation) => citation.status === "unchecked").length;
      const guidance = [
        coverage,
        unchecked ? `${unchecked} citation${unchecked === 1 ? " was" : "s were"} not checked. Ask the user to enable automatic citation verification, or check them yourself from the returned snapshot. Do not report them as verified.` : null,
        "Only DOI and arXiv identifiers are checked. PMIDs, bare titles and citations that only appear in attachments are not checked.",
        "A found record only means the source lists this identifier. It does not mean the paper supports the claim it is attached to.",
        "The bibliographic check compares the reference entry the answer printed with the record. 'Not compared' means the answer stated no title for that identifier, which is not a match.",
        "For each citation above, judge whether its evidence supports the claim it is attached to:",
        "- supports: the abstract/metadata clearly backs the claim",
        "- does not support: the claim goes beyond or contradicts the evidence",
        "- could not check: the lookup failed, the record is missing, or the cited version is not confirmed",
        "State this judgement per citation in your reply and flag retraction notices prominently.",
      ].filter((line): line is string => line !== null).join("\n");
      return { content: [{ type: "text", text: `${lines.join("\n\n---\n\n")}\n\n${guidance}` }], details: { citations: citations.length, total, unprocessed: unprocessed.length } };
    },
  };
}
