import { randomUUID } from "node:crypto";
import { candidateProposalSchema, type AutoResearchSnapshot, type CandidateProposal } from "@pi-science/contracts";
import { z } from "zod";
import { PiManagedResearchRuntime } from "../runtimes/pi-managed-runtime.js";

// Candidate details returned by the materializer runtime. Duplicated from
// candidateProposalSchema (minus parent_candidate_ids) because zod v4 does not
// allow .omit() on a refined schema; the entrypoint-in-files rule is repeated
// so materialization retries (not the executor) catch broken candidates.
const materializedSchema = z.object({
  approach_summary: z.string().min(1).max(4000),
  rationale: z.string().max(8000).default(""),
  files: z.record(z.string(), z.string()).refine(
    (files) => Object.keys(files).length > 0 && Object.keys(files).length <= 100,
    "files must contain 1-100 entries",
  ),
  entrypoint: z.string().min(1).max(500).default("solve.sh"),
  expected_artifacts: z.array(z.object({ path: z.string(), kind: z.string().default("data") })).default([]),
  research_id: z.string(),
  node_id: z.string(),
}).refine(
  (candidate) => Object.keys(candidate.files).includes(candidate.entrypoint),
  "entrypoint must be included in candidate files",
);

/** Default wall-clock budget for one experiment materialization. Model
 *  sessions that write, run, and debug an executable candidate routinely
 *  exceed ten minutes, so the shared runtime default is not enough here. */
const MATERIALIZATION_TIMEOUT_MS = Number(process.env.PI_SCIENCE_EXPERIMENT_MATERIALIZATION_TIMEOUT_MS ?? 30 * 60_000);

/** Materialization failure that also carries the tokens/cost consumed by all
 *  attempts, so the research can still account the spend. */
export class MaterializationError extends Error {
  constructor(message: string, readonly model_tokens: number, readonly cost_usd: number) {
    super(message);
  }
}

export interface MaterializedExperiment {
  proposal: CandidateProposal;
  model_tokens: number;
  cost_usd: number;
}

export interface ExperimentMaterializer {
  materialize(cwd: string, snapshot: AutoResearchSnapshot, nodeId: string): Promise<MaterializedExperiment>;
  shutdown(): Promise<void>;
  cancelResearch(researchId: string): Promise<void>;
}

function failedUsage(error: unknown): { model_tokens: number; cost_usd: number } {
  const record = error && typeof error === "object" ? error as { model_tokens?: unknown; cost_usd?: unknown } : {};
  return {
    model_tokens: typeof record.model_tokens === "number" ? record.model_tokens : 0,
    cost_usd: typeof record.cost_usd === "number" ? record.cost_usd : 0,
  };
}

export class PiExperimentMaterializer implements ExperimentMaterializer {
  constructor(private readonly runtime: PiManagedResearchRuntime, private readonly maxMaterializeAttempts = 3) {}

  async materialize(cwd: string, snapshot: AutoResearchSnapshot, nodeId: string): Promise<MaterializedExperiment> {
    const node = snapshot.nodes.find((candidate) => candidate.node_id === nodeId);
    if (!node || node.kind !== "experiment") throw new Error("experiment node is unavailable for materialization");
    let lastError: unknown;
    let failedTokens = 0;
    let failedCost = 0;
    for (let attempt = 1; attempt <= this.maxMaterializeAttempts; attempt += 1) {
      try {
        const result = await this.runtime.run({
          cwd,
          research_id: snapshot.research_id,
          operation_id: `materialize-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
          role: `materializer-${nodeId}`,
          expected_tool: "research_materialize",
          timeout_ms: MATERIALIZATION_TIMEOUT_MS,
          prompt: [
            "You are a Node-managed Experiment Materializer Runtime. Turn the approved experiment spec into a conservative, self-contained executable candidate.",
            "Inspect the workspace as needed. Finish by calling research_materialize exactly once; do not print JSON.",
            "The entrypoint must write result.json and every expected artifact beneath PI_SCIENCE_OUTPUT_DIR. Do not change the formal expected metrics.",
            "research_materialize details must include research_id and node_id copied verbatim from the experiment node below.",
            "candidate files must contain the entrypoint: the entrypoint value MUST be one of the files keys, exactly as written (no path prefix, no extension mismatch).",
            "result.json MUST include every expected metric from the experiment spec as a JSON number field (e.g. {\"count_hits\": 12}). Never write strings, lists, or paths for a metric; an experiment with non-numeric metric values is rejected as invalid.",
            ...(attempt > 1 && lastError
              ? [`Your previous materialization was rejected:\n${String(lastError)}\nFix the returned details (especially research_id and node_id, copied verbatim) and call research_materialize again.`]
              : []),
            `Research objective: ${snapshot.objective}`,
            `Constraints: ${JSON.stringify(snapshot.constraints)}`,
            `Experiment node: ${JSON.stringify(node, null, 2)}`,
          ].join("\n\n"),
        });
        const parsed = materializedSchema.parse(result.details);
        if (parsed.research_id !== snapshot.research_id || parsed.node_id !== nodeId) throw new Error("materializer result identity mismatch");
        return {
          proposal: candidateProposalSchema.parse({
            approach_summary: parsed.approach_summary,
            rationale: parsed.rationale,
            files: parsed.files,
            entrypoint: parsed.entrypoint,
            parent_candidate_ids: [],
            expected_artifacts: parsed.expected_artifacts,
          }),
          model_tokens: failedTokens + result.model_tokens,
          cost_usd: failedCost + result.cost_usd,
        };
      } catch (error) {
        const usage = failedUsage(error);
        failedTokens += usage.model_tokens;
        failedCost += usage.cost_usd;
        lastError = error;
        if (attempt === this.maxMaterializeAttempts) break;
      }
    }
    throw new MaterializationError(String(lastError), failedTokens, failedCost);
  }

  shutdown() { return this.runtime.shutdown(); }
  cancelResearch(researchId: string) { return this.runtime.cancelResearch(researchId); }
}
