import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResearchGraphStore } from "./store.js";
import { StaleResearchGraphError } from "./validator.js";

describe("ResearchGraphStore", () => {
  it("atomically resolves action-local node references", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "research-graph-"));
    const store = new ResearchGraphStore();
    const created = await store.create(cwd, { title: "Improve", objective: "Improve accuracy" });
    const { snapshot } = await store.commit(cwd, {
      research_id: created.research_id,
      base_revision: 0,
      actions: [
        { action_id: "h1", type: "hypothesis.add", statement: "Warmup helps", parent_refs: [{ node_id: created.nodes[0]!.node_id }] },
        { action_id: "e1", type: "experiment.propose", hypothesis_ref: { action_id: "h1" }, spec: { objective: "Try warmup", expected_metrics: ["accuracy"] } },
      ],
    });
    expect(snapshot.revision).toBe(1);
    const hypothesis = snapshot.nodes.find((node) => node.kind === "hypothesis")!;
    const experiment = snapshot.nodes.find((node) => node.kind === "experiment")!;
    expect(experiment.kind === "experiment" && experiment.hypothesis_id).toBe(hypothesis.node_id);
    expect(snapshot.edges.some((edge) => edge.from === hypothesis.node_id && edge.to === experiment.node_id && edge.relation === "tests")).toBe(true);
  });

  it("rejects a stale commit without appending any mutation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "research-graph-stale-"));
    const store = new ResearchGraphStore();
    const created = await store.create(cwd, { title: "R", objective: "Question" });
    const commit = { research_id: created.research_id, base_revision: 0, actions: [{ action_id: "q", type: "question.add", question: "Subquestion" }] };
    await store.commit(cwd, commit);
    await expect(store.commit(cwd, commit)).rejects.toBeInstanceOf(StaleResearchGraphError);
    expect((await store.snapshot(cwd, created.research_id))?.revision).toBe(1);
  });
});
