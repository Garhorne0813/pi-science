import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AutoResearchSnapshot, ResearchNode } from "@pi-science/contracts";
import { PiManagedResearchRuntime } from "../runtimes/pi-managed-runtime.js";

const workerResultSchema = z.object({
  research_id: z.string(),
  node_id: z.string(),
  kind: z.enum(["literature", "analysis", "verification", "synthesis"]),
  summary: z.string(),
  findings: z.array(z.record(z.string(), z.unknown())).default([]),
  claims: z.array(z.object({ statement: z.string(), confidence: z.number().min(0).max(1).default(0.5), scope: z.string().nullable().default(null) })).default([]),
  verdict: z.enum(["verified", "failed"]).optional(),
});

export type ResearchWorkerResult = z.infer<typeof workerResultSchema> & { model_tokens: number; cost_usd: number };

export interface ResearchWorker {
  run(cwd: string, snapshot: AutoResearchSnapshot, node: ResearchNode): Promise<ResearchWorkerResult>;
  cancelResearch(researchId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export class PiResearchWorker implements ResearchWorker {
  constructor(private readonly runtime: PiManagedResearchRuntime) {}

  async run(cwd: string, snapshot: AutoResearchSnapshot, node: ResearchNode): Promise<ResearchWorkerResult> {
    if (!["literature", "analysis", "verification", "synthesis"].includes(node.kind)) throw new Error(`unsupported research worker node: ${node.kind}`);
    const result = await this.runtime.run({
      cwd,
      research_id: snapshot.research_id,
      operation_id: `worker-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      role: `${node.kind}-${node.node_id}`,
      expected_tool: "research_worker_result",
      prompt: [
        `You are a Node-managed ${node.kind} Research Worker Runtime. Complete exactly this durable node and no other work.`,
        "Use available read-only scientific tools and web/literature tools when relevant. Do not edit experiment code, start jobs, or mutate the Research Graph.",
        "Finish by calling research_worker_result exactly once. Claims must be scoped and evidence-conscious; never fabricate citations or experimental metrics.",
        `Research objective: ${snapshot.objective}`,
        `Constraints: ${JSON.stringify(snapshot.constraints)}`,
        `Target node: ${JSON.stringify(node, null, 2)}`,
        `Relevant nodes: ${JSON.stringify(snapshot.nodes.filter((candidate) => candidate.node_id === (node.kind === "verification" ? node.target_node_id : candidate.node_id)).slice(-20), null, 2)}`,
      ].join("\n\n"),
    });
    const parsed = workerResultSchema.parse(result.details);
    if (parsed.research_id !== snapshot.research_id || parsed.node_id !== node.node_id || parsed.kind !== node.kind) throw new Error("research worker result identity mismatch");
    return { ...parsed, model_tokens: result.model_tokens, cost_usd: result.cost_usd };
  }

  shutdown() { return this.runtime.shutdown(); }
  cancelResearch(researchId: string) { return this.runtime.cancelResearch(researchId); }
}
