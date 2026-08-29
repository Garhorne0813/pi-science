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
  constructor(private readonly runtime: PiManagedResearchRuntime) {}

  async decide(cwd: string, snapshot: AutoResearchSnapshot): Promise<SupervisorDecision> {
    const operationId = `supervisor-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const result = await this.runtime.run({
      cwd,
      research_id: snapshot.research_id,
      operation_id: operationId,
      role: "supervisor",
      expected_tool: "research_commit",
      prompt: supervisorPrompt(snapshot),
    });
    return { commit: researchCommitSchema.parse(result.details), model_tokens: result.model_tokens, cost_usd: result.cost_usd };
  }

  cancel(operationId: string) { return this.runtime.cancel(operationId); }
  cancelResearch(researchId: string) { return this.runtime.cancelResearch(researchId); }
  shutdown() { return this.runtime.shutdown(); }
}

function supervisorPrompt(snapshot: AutoResearchSnapshot): string {
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
  return [
    "You are a Node-managed Research Supervisor Runtime. Decide what scientific work is worth doing next; never execute experiments yourself.",
    "You may use pi-subagents for bounded planner, literature-scout, hypothesis-generator, critic, reviewer, methodologist, or claim-verifier work. Their output is advisory and must return to you.",
    "Finish by calling research_commit exactly once. Do not print JSON. Use the supplied research_id and base_revision unchanged.",
    "Prefer a small coherent batch. Create hypotheses before experiments and use action_id references within the batch. Request verification for material claims. Ask for user input only when a material choice cannot be inferred.",
    "Before recommending stop, request a synthesis node over the material completed nodes in the same commit unless a completed synthesis already exists. Recommend stopping only when targets are reached, the frontier is exhausted, or remaining work has low value. Node retains final stop authority.",
    `Research snapshot:\n${JSON.stringify(compact, null, 2)}`,
  ].join("\n\n");
}
