/**
 * Science review mode for the project review pipeline.
 *
 * Where the default project review proposes durable knowledge, the science
 * review checks the latest report-shaped assistant turn for scientific
 * integrity: claims vs executions, numbers vs recorded results, citations vs
 * the verified evidence snapshots, and plan completion. Findings land in the
 * same pending-proposal queue with human approval — nothing is auto-applied.
 *
 * Off by default; enabled with PI_SCIENCE_SCIENCE_REVIEW=1 or a manual
 * endpoint call, which works regardless of the automatic gate.
 */
import { citationVerifyService, extractCitations, MAX_CITATIONS_PER_CALL, type CitationView } from "../runtime/citations/citation-verify-service.js";
import { executionRepository } from "../runtime/executions/execution-repository.js";
import type { ConversationExcerpt } from "./types.js";

export const SCIENCE_REVIEW_ENV = "PI_SCIENCE_SCIENCE_REVIEW";

const REPORT_MIN_CHARS = 1_200;
const REPORT_MIN_CITATIONS = 3;
const REPORT_PATH_PATTERN = /[\w./\\-]+\.(?:pdf|md|html|docx|pptx|csv|png|jpe?g|svg)\b/gi;
const MAX_EVIDENCE_EXECUTIONS = 20;

export function scienceReviewEnabled(): boolean {
  return process.env[SCIENCE_REVIEW_ENV] === "1" || process.env[SCIENCE_REVIEW_ENV] === "true";
}

/** A report-shaped turn: long-form output, several citations, or file artifacts. */
export function isReportTurn(text: string): boolean {
  if (text.length >= REPORT_MIN_CHARS) return true;
  if (extractCitations(text).length >= REPORT_MIN_CITATIONS) return true;
  return [...text.matchAll(REPORT_PATH_PATTERN)].length >= 2;
}

/** One citation as the reviewer sees it: what the sources answered, whether
 *  the snapshot describes the cited version, and where it disagrees with the
 *  reference entry the answer printed. */
function citationEvidenceLine(view: CitationView): string {
  const state = view.retraction === "retracted" ? "RETRACTED"
    : view.status === "unchecked" ? "NOT CHECKED"
    : view.status === "not_found" ? `NOT FOUND in ${view.checked_providers.join(", ") || "the queried sources"}`
    : view.status === "error" ? `CHECK FAILED${view.error ? ` (${view.error})` : ""}`
    : "verified";
  const record = [view.title, view.year ? `(${view.year})` : null].filter(Boolean).join(" ") + (view.journal ? `, ${view.journal}` : "");
  const abstract = view.abstract ? ` Abstract (source summary, truncated): ${view.abstract.slice(0, 240)}${view.abstract.length > 240 ? "…" : ""}` : "";
  const notes = [
    view.status === "found" && view.kind === "arxiv" ? (view.version === "confirmed" ? `version ${view.requested_version} confirmed` : view.requested_version ? `cited version ${view.requested_version} not confirmed (record has ${view.record_version ?? "an unknown version"})` : "no version cited") : "",
    view.bibliographic === "match" ? "reference entry matches the record" : view.bibliographic === "mismatch" ? `reference entry does not match the record: ${view.bibliographic_note ?? ""}` : "",
    view.retraction === "retracted" && view.retraction_url ? `notice: ${view.retraction_url}` : "",
    view.status_note ?? "",
  ].filter(Boolean);
  return `- ${view.kind}:${view.requested_id} [${state}] ${record ? `${record}.` : "No bibliographic record."}${abstract}${notes.length ? ` [${notes.join("; ")}]` : ""}`;
}

/** Assemble the evidence pack for the reviewer: citation snapshots (from the
 *  free-API verification cache) plus the session's recent execution records. */
export async function buildScienceEvidence(cwd: string, sessionText: string, sessionId: string): Promise<string> {
  const sections: string[] = [];

  const citations = extractCitations(sessionText);
  if (citations.length) {
    // Report every citation the text carries, not only the cached ones: a
    // snapshot for one DOI must never make the rest of the list look checked.
    const verification = await citationVerifyService.lookupText(cwd, { text: sessionText });
    const unchecked = verification.citations.filter((view) => view.status === "unchecked").length;
    sections.push([
      "Citation evidence, one line per citation in the report:",
      ...verification.citations.map(citationEvidenceLine),
      verification.unprocessed.length
        ? `NOT CHECKED (over the ${MAX_CITATIONS_PER_CALL} per-call verification limit): ${verification.unprocessed.map((ref) => `${ref.kind}:${ref.requested_id}`).join(", ")}`
        : "",
      unchecked ? `${unchecked} citation(s) in the text have NOT been verified (no snapshots). Ask the agent to run verify_citations.` : "",
      "Limits: a found record, an abstract or a matching reference entry shows what the source is, never that the source supports the sentence citing it. Treat an unchecked or failed lookup as unknown, and a missing retraction notice as unknown rather than cleared.",
    ].filter(Boolean).join("\n"));
  }

  const executions = await executionRepository.list(cwd, { session_id: sessionId, limit: MAX_EVIDENCE_EXECUTIONS });
  if (executions.length) {
    const lines = executions.map((execution) => {
      const result = execution.result as Record<string, unknown>;
      const preview = typeof result.stdout_preview === "string" ? String(result.stdout_preview).slice(0, 200) : typeof result.output_preview === "string" ? String(result.output_preview).slice(0, 200) : "";
      return `- ${execution.kind}/${execution.surface} ${execution.status} at ${execution.started_at ?? execution.created_at}${preview ? `: ${preview}` : ""}`;
    });
    sections.push(`Recent execution records for this session (what actually ran):\n${lines.join("\n")}`);
  } else {
    sections.push("Execution records: no executions were recorded for this session.");
  }

  return sections.join("\n\n");
}

/** Prompt for the science reviewer; output contract matches the proposal
 *  schema so findings flow into the existing approval queue unchanged. */
export function scienceReviewPrompt(excerpt: ConversationExcerpt, evidence: string): string {
  const transcript = excerpt.messages.map((message) => `<message id="${message.id}" role="${message.role}">\n${message.text}\n</message>`).join("\n");
  return [
    "You are the science reviewer for a scientific workspace. Review the assistant's latest report in the conversation below for scientific integrity. Check four things:",
    "1. Claims vs execution: statements that code or analysis was run must be backed by the execution records; flag claims with no matching execution.",
    "2. Numbers vs sources: reported numbers should be consistent with recorded execution output previews; flag unexplained discrepancies.",
    "3. Citations vs claims: citations marked verified must actually support the claim they are attached to; flag retracted sources and citations with no verification snapshot.",
    "4. Plan completion: promised steps that were silently dropped.",
    "Rules: propose between 0 and 5 findings; propose nothing when the report is consistent and honest; each finding must cite the specific sentence and the contradicting evidence.",
    "Each finding is an object with: knowledge_type (use \"finding\"), title (<= 120 characters, prefix with the check it failed, e.g. \"Citation does not support claim:\"), summary (2-4 sentences naming the sentence and the evidence), reason (the check it failed and why it matters), confidence (low|medium|high), importance (normal|important|critical — critical for fabricated results or retracted citations), related_files, message_ids.",
    "Do not edit files, do not run code, and do not use tools. Return ONLY a JSON array of those objects — no markdown fences, no prose. Return [] when the report passes.",
    excerpt.truncated ? "The excerpt below is the tail of a longer conversation." : "",
    `<conversation session_id="${excerpt.session_id}">\n${transcript}\n</conversation>`,
    `<evidence>\n${evidence}\n</evidence>`,
  ].filter(Boolean).join("\n\n");
}
