import { randomUUID } from "node:crypto";
import { candidateProposalSchema, type AutoResearchSnapshot, type CandidateProposal } from "@pi-science/contracts";
import { z } from "zod";
import { PiManagedResearchRuntime } from "../runtimes/pi-managed-runtime.js";

const materializedSchema = candidateProposalSchema.omit({ parent_candidate_ids: true }).extend({
  research_id: z.string(),
  node_id: z.string(),
});

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

export class PiExperimentMaterializer implements ExperimentMaterializer {
  constructor(private readonly runtime: PiManagedResearchRuntime) {}

  async materialize(cwd: string, snapshot: AutoResearchSnapshot, nodeId: string): Promise<MaterializedExperiment> {
    const node = snapshot.nodes.find((candidate) => candidate.node_id === nodeId);
    if (!node || node.kind !== "experiment") throw new Error("experiment node is unavailable for materialization");
    const result = await this.runtime.run({
      cwd,
      research_id: snapshot.research_id,
      operation_id: `materialize-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      role: `materializer-${nodeId}`,
      expected_tool: "research_materialize",
      prompt: [
        "You are a Node-managed Experiment Materializer Runtime. Turn the approved experiment spec into a conservative, self-contained executable candidate.",
        "Inspect the workspace as needed. Finish by calling research_materialize exactly once; do not print JSON.",
        "The entrypoint must write result.json and every expected artifact beneath PI_SCIENCE_OUTPUT_DIR. Do not change the formal expected metrics.",
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
      model_tokens: result.model_tokens,
      cost_usd: result.cost_usd,
    };
  }

  shutdown() { return this.runtime.shutdown(); }
  cancelResearch(researchId: string) { return this.runtime.cancelResearch(researchId); }
}
