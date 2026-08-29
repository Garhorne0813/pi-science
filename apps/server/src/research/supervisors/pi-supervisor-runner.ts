import { randomUUID } from "node:crypto";
import { researchCommitSchema, type AutoResearchSnapshot, type ResearchCommit } from "@pi-science/contracts";
import { PiManagedResearchRuntime } from "../runtimes/pi-managed-runtime.js";

export interface SupervisorDecision {
  commit: ResearchCommit;
  model_tokens: number;
  cost_usd: number;
}

export interface ResearchSupervisor {
  decide(cwd: string, snapshot: AutoResearchSnapshot): Promise<SupervisorDecision>;
  cancel(operationId: string): Promise<void>;
  cancelResearch(researchId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export class PiResearchSupervisor implements ResearchSupervisor {
  constructor(private readonly runtime: PiManagedResearchRuntime, private readonly maxCommitAttempts = 3) {}

  async decide(cwd: string, snapshot: AutoResearchSnapshot): Promise<SupervisorDecision> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxCommitAttempts; attempt += 1) {
      const operationId = `supervisor-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      try {
        const result = await this.runtime.run({
          cwd,
          research_id: snapshot.research_id,
          operation_id: operationId,
          role: "supervisor",
          expected_tool: "research_commit",
          prompt: supervisorPrompt(snapshot, attempt, lastError),
        });
        return { commit: researchCommitSchema.parse(result.details), model_tokens: result.model_tokens, cost_usd: result.cost_usd };
      } catch (error) {
        // A model-generated commit can be schema-invalid (e.g. fabricated node
        // ids). A single bad plan must not sink the whole research: retry with
        // the validation error fed back, fail only after exhausting attempts.
        lastError = error;
        if (attempt === this.maxCommitAttempts) throw error;
      }
    }
    throw lastError;
  }

  cancel(operationId: string) { return this.runtime.cancel(operationId); }
  cancelResearch(researchId: string) { return this.runtime.cancelResearch(researchId); }
  shutdown() { return this.runtime.shutdown(); }
}

function supervisorPrompt(snapshot: AutoResearchSnapshot, attempt = 1, lastError?: unknown): string {
  const compact = {
    research_id: snapshot.research_id,
    revision: snapshot.revision,
    objective: snapshot.objective,
    constraints: snapshot.constraints,
    budget: snapshot.budget,
    usage: snapshot.usage,
    target_metrics: snapshot.target_metrics,
    nodes: snapshot.nodes.map((node) => ({ ...node, ...(node.kind === "experiment" && node.result ? { result: node.result } : {}) })),
    edges: snapshot.edges,
    claims: snapshot.claims,
    best_result: snapshot.best_result,
    stop_reason: snapshot.stop_reason,
  };
  const recentFailures = snapshot.nodes
    .filter((node): node is Extract<AutoResearchSnapshot["nodes"][number], { kind: "experiment" }> => node.kind === "experiment" && node.status === "failed")
    .map((node) => `${node.kind} ${node.node_id}: ${String((node.result as { error?: unknown } | undefined)?.error ?? "unknown error").slice(0, 280)}`)
    .slice(-5);
  return [
    "You are a Node-managed Research Supervisor Runtime. Decide what scientific work is worth doing next; never execute experiments yourself.",
    "You may use pi-subagents for bounded planner, literature-scout, hypothesis-generator, critic, reviewer, methodologist, or claim-verifier work. Their output is advisory and must return to you.",
    "Finish by calling research_commit exactly once. Do not print JSON. Use the supplied research_id and base_revision unchanged.",
    "Prefer a small coherent batch. Create hypotheses before experiments and use action_id references within the batch. Request verification for material claims. Ask for user input only when a material choice cannot be inferred.",
    "Node id rules: every node reference (hypothesis parent_refs, experiment.propose, verification.request target_node_id, synthesis.request target_node_ids, input.request target_node_id) MUST be copied verbatim from the snapshot nodes array. Never invent, shorten, reformat, or guess node ids. If a referenced node is not in the snapshot, omit the action instead of fabricating an id.",
    ...(recentFailures.length > 0
      ? [
          `The following experiments FAILED with these errors:\n${recentFailures.join("\n")}\nDo NOT propose the same or near-identical experiment directions again (same objective, same expected metrics, same method). Propose a different approach, split the question into a simpler standalone experiment, or recommend stopping.`,
        ]
      : []),
    "Before recommending stop, request a synthesis node over the material completed nodes in the same commit unless a completed synthesis already exists. Recommend stopping only when targets are reached, the frontier is exhausted, or remaining work has low value. Node retains final stop authority.",
    ...(attempt > 1 && lastError
      ? [`Your previous commit was rejected by validation:\n${String(lastError)}\nFix the referenced node ids (copy them verbatim from the snapshot) and produce a valid commit.`]
      : []),
    `Research snapshot:\n${JSON.stringify(compact, null, 2)}`,
  ].join("\n\n");
}
