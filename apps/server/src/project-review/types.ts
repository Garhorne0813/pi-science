import { z } from "zod";

export const knowledgeTypes = ["finding", "conclusion", "decision", "hypothesis", "question", "task", "project_change", "artifact"] as const;

const strings = z.array(z.unknown()).transform((value) => value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 20)).catch([]);
const proposalSchema = z.object({
  knowledge_type: z.enum(knowledgeTypes).catch("finding"),
  title: z.string().trim().min(1).transform((value) => value.slice(0, 200)),
  summary: z.string().trim().min(1).transform((value) => value.slice(0, 4_000)),
  reason: z.string().trim().transform((value) => value.slice(0, 2_000)).catch(""),
  confidence: z.enum(["low", "medium", "high"]).catch("medium"),
  importance: z.enum(["normal", "important", "critical"]).catch("normal"),
  related_files: strings,
  message_ids: strings,
});
// The subagent is asked for a bare array; tolerate the wrapped object because
// models routinely add the envelope back.
const resultSchema = z.preprocess((value) => (Array.isArray(value) ? { proposals: value } : value), z.object({ proposals: z.array(proposalSchema) }));

export type ReviewProposal = z.infer<typeof proposalSchema>;
export type ReviewResult = { proposals: ReviewProposal[] };

export interface ExcerptMessage { id: string; role: string; text: string }
export interface ConversationExcerpt { session_id: string; messages: ExcerptMessage[]; truncated: boolean }

export interface ReviewRunRequest { run_id: string; cwd: string; session_id: string; excerpt: ConversationExcerpt }
export interface ReviewRunResult { run_id: string; output: ReviewResult }

export interface ReviewSubagentRunner {
  run(request: ReviewRunRequest): Promise<ReviewRunResult>;
  shutdown(): Promise<void>;
}

/** Parse a subagent response into proposals, tolerating markdown fences and surrounding prose. */
export function parseReviewResult(response: string): ReviewResult {
  return resultSchema.parse(extractJson(response));
}

function extractJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(trimmed); } catch { /* use bounded extraction */ }
  for (const [open, close] of [["[", "]"], ["{", "}"]] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* try the other delimiter */ }
    }
  }
  throw new Error("project reviewer did not return JSON");
}
