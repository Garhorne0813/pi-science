import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateProposalSchema, type AutoResearchSnapshot, type ResearchNode } from "@pi-science/contracts";
import type { ResearchExperimentExecutor } from "../executors/experiment-executor.js";
import type { ResearchWorker } from "../executors/pi-research-worker.js";
import { ResearchGraphStore } from "../graph/store.js";
import type { ExperimentMaterializer } from "../materializers/pi-experiment-materializer.js";
import type { ResearchSupervisor } from "../supervisors/pi-supervisor-runner.js";
import { ResearchOrchestrator } from "./coordinator.js";

describe("ResearchOrchestrator", () => {
  it("drives decision epoch, bounded experiment execution, synthesis, and deterministic stop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "research-orchestrator-"));
    let decisions = 0;
    const supervisor: ResearchSupervisor = {
      async decide(_cwd, snapshot) {
        decisions += 1;
        if (decisions === 1) return { model_tokens: 10, cost_usd: 0.01, commit: {
          research_id: snapshot.research_id, base_revision: snapshot.revision, rationale: "test",
          actions: [
            { action_id: "h1", type: "hypothesis.add", statement: "Change helps", assumptions: [], parent_refs: [{ node_id: snapshot.nodes[0]!.node_id }] },
            { action_id: "e1", type: "experiment.propose", hypothesis_ref: { action_id: "h1" }, spec: { objective: "run", expected_metrics: ["score"], constraints: [], materialization: "pi_candidate" }, priority: 1 },
          ],
        } };
        const material = snapshot.nodes.filter((node) => node.kind === "experiment").map((node) => node.node_id);
        return { model_tokens: 5, cost_usd: 0.01, commit: {
          research_id: snapshot.research_id, base_revision: snapshot.revision, rationale: "done",
          actions: [
            { action_id: "s1", type: "synthesis.request", target_node_ids: material, priority: 1 },
            { action_id: "stop", type: "research.stop_recommended", reason: "evidence complete" },
          ],
        } };
      },
      async cancel() {}, async cancelResearch() {}, async shutdown() {},
    };
    const materializer: ExperimentMaterializer = {
      async materialize() { return { proposal: candidateProposalSchema.parse({ approach_summary: "candidate", files: { "solve.sh": "echo" }, entrypoint: "solve.sh" }), model_tokens: 3, cost_usd: 0.01 }; },
      async cancelResearch() {}, async shutdown() {},
    };
    const experiments: ResearchExperimentExecutor = {
      async start(_cwd, _researchId, node) { return { candidate_id: "candidate-test", job_id: `job_${node.node_id.slice(-16)}`, run_id: "run-test", outputs_dir: ".pi-science/out" }; },
      async reconcile(_cwd, _node, handle) { return { status: "succeeded", handle, result: { metrics: { score: 0.9 }, candidate_id: handle.candidate_id } }; },
      async cancel() {},
    };
    const workers: ResearchWorker = {
      async run(_cwd, snapshot, node) { return { research_id: snapshot.research_id, node_id: node.node_id, kind: node.kind as "synthesis", summary: "Final synthesis", findings: [], claims: [{ statement: "Score improved", confidence: 0.9, scope: null }], model_tokens: 4, cost_usd: 0.01 }; },
      async cancelResearch() {}, async shutdown() {},
    };
    const orchestrator = new ResearchOrchestrator(new ResearchGraphStore(), supervisor, materializer, experiments, workers);
    const created = await orchestrator.create(cwd, { title: "Research", objective: "Improve", target_metrics: { score: { value: 0.95, direction: "maximize" } } });
    await orchestrator.start(cwd, created.research_id);
    const completed = await waitFor(async () => orchestrator.detail(cwd, created.research_id), (snapshot) => snapshot?.status === "completed");
    expect(completed?.best_result).toMatchObject({ metrics: { score: 0.9 } });
    expect(completed?.nodes.some((node) => node.kind === "synthesis" && node.status === "succeeded")).toBe(true);
    expect(completed?.claims.some((claim) => claim.statement === "Score improved")).toBe(true);
    expect(completed?.usage).toMatchObject({ experiments_started: 1, experiments_completed: 1, model_tokens: 22 });
    expect(completed?.stop_reason).toContain("supervisor_recommended");
    await orchestrator.shutdown();
  });

  it("reserves the final experiment slot once and synthesizes before budget stop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "research-budget-"));
    let starts = 0;
    const supervisor: ResearchSupervisor = {
      async decide(_cwd, snapshot) { return { model_tokens: 1, cost_usd: 0, commit: {
        research_id: snapshot.research_id, base_revision: snapshot.revision, rationale: "parallel proposals",
        actions: [
          { action_id: "h", type: "hypothesis.add", statement: "Try two variants", assumptions: [], parent_refs: [{ node_id: snapshot.nodes[0]!.node_id }] },
          { action_id: "e1", type: "experiment.propose", hypothesis_ref: { action_id: "h" }, spec: { objective: "one", expected_metrics: ["score"], constraints: [], materialization: "pi_candidate" }, priority: 2 },
          { action_id: "e2", type: "experiment.propose", hypothesis_ref: { action_id: "h" }, spec: { objective: "two", expected_metrics: ["score"], constraints: [], materialization: "pi_candidate" }, priority: 1 },
        ],
      } }; },
      async cancel() {}, async cancelResearch() {}, async shutdown() {},
    };
    const materializer: ExperimentMaterializer = {
      async materialize() { return { proposal: candidateProposalSchema.parse({ approach_summary: "candidate", files: { "solve.sh": "echo" }, entrypoint: "solve.sh" }), model_tokens: 0, cost_usd: 0 }; },
      async cancelResearch() {}, async shutdown() {},
    };
    const experiments: ResearchExperimentExecutor = {
      async start(_cwd, _researchId, node) { starts += 1; return { candidate_id: `candidate-${starts}`, job_id: `job_${node.node_id.slice(-16)}`, run_id: `run-${starts}`, outputs_dir: ".pi-science/out" }; },
      async reconcile(_cwd, _node, handle) { return { status: "succeeded", handle, result: { metrics: { score: 1 }, candidate_id: handle.candidate_id } }; },
      async cancel() {},
    };
    const workers: ResearchWorker = {
      async run(_cwd, snapshot, node) { return { research_id: snapshot.research_id, node_id: node.node_id, kind: node.kind as "synthesis", summary: "Budget synthesis", findings: [], claims: [], model_tokens: 0, cost_usd: 0 }; },
      async cancelResearch() {}, async shutdown() {},
    };
    const orchestrator = new ResearchOrchestrator(new ResearchGraphStore(), supervisor, materializer, experiments, workers);
    const created = await orchestrator.create(cwd, { title: "Bounded", objective: "Do one", budget: { max_experiments: 1, max_parallel: 2 } });
    await orchestrator.start(cwd, created.research_id);
    const completed = await waitFor(async () => orchestrator.detail(cwd, created.research_id), (snapshot) => snapshot?.status === "completed");
    expect(starts).toBe(1);
    expect(completed?.usage).toMatchObject({ experiments_started: 1, experiments_completed: 1 });
    expect(completed?.nodes.filter((node) => node.kind === "experiment").map((node) => node.status).sort()).toEqual(["ready", "succeeded"]);
    expect(completed?.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "synthesis", status: "succeeded", summary: "Budget synthesis" })]));
    expect(completed?.stop_reason).toBe("experiment_budget_exhausted");
    await orchestrator.shutdown();
  });
});

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for research state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it("accounts the spend of a failed experiment materialization", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "research-failed-usage-"));
  let decisions = 0;
  const supervisor: ResearchSupervisor = {
    async decide(_cwd, snapshot) {
      decisions += 1;
      if (decisions === 1) return { model_tokens: 10, cost_usd: 0.01, commit: {
        research_id: snapshot.research_id, base_revision: snapshot.revision, rationale: "one experiment",
        actions: [
          { action_id: "h1", type: "hypothesis.add", statement: "H", assumptions: [], parent_refs: [{ node_id: snapshot.nodes[0]!.node_id }] },
          { action_id: "e1", type: "experiment.propose", hypothesis_ref: { action_id: "h1" }, spec: { objective: "run", expected_metrics: ["score"], constraints: [], materialization: "pi_candidate" }, priority: 1 },
        ],
      } };
      return { model_tokens: 5, cost_usd: 0, commit: {
        research_id: snapshot.research_id, base_revision: snapshot.revision, rationale: "stop",
        actions: [{ action_id: "stop", type: "research.stop_recommended", reason: "scope exhausted" }],
      } };
    },
    async cancel() {}, async cancelResearch() {}, async shutdown() {},
  };
  const materializer: ExperimentMaterializer = {
    async materialize() { throw Object.assign(new Error("materializer runtime timed out"), { model_tokens: 5_000, cost_usd: 0.01 }); },
    async cancelResearch() {}, async shutdown() {},
  };
  const experiments: ResearchExperimentExecutor = {
    async start() { throw new Error("unused"); },
    async reconcile() { throw new Error("unused"); },
    async cancel() {},
  };
  const workers: ResearchWorker = {
    async run(_cwd, snapshot, node) {
      if (node.kind !== "synthesis") throw new Error("unused");
      return { research_id: snapshot.research_id, node_id: node.node_id, kind: "synthesis", summary: "synth", findings: [], claims: [], model_tokens: 1, cost_usd: 0 };
    },
    async cancelResearch() {}, async shutdown() {},
  };
  const orchestrator = new ResearchOrchestrator(new ResearchGraphStore(), supervisor, materializer, experiments, workers);
  const created = await orchestrator.create(cwd, { title: "R", objective: "run" });
  await orchestrator.start(cwd, created.research_id);
  const final = await waitFor(async () => orchestrator.detail(cwd, created.research_id), (snapshot) => !!snapshot && ["completed", "failed"].includes(snapshot.status));
  // The failed materialization's spend is reflected in the research usage.
  expect(final?.usage.model_tokens).toBeGreaterThanOrEqual(5_000);
  expect(final?.usage.cost_usd).toBeGreaterThanOrEqual(0.01);
  expect(final?.nodes.find((node) => node.kind === "experiment")?.status).toBe("failed");
  await orchestrator.shutdown();
}, 15_000);
