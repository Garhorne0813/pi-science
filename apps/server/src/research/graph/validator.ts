import { randomUUID } from "node:crypto";
import {
  researchCommitSchema,
  type AutoResearchSnapshot,
  type ResearchAction,
  type ResearchClaim,
  type ResearchEdge,
  type ResearchNode,
  type ResearchNodeRef,
} from "@pi-science/contracts";
import type { ResearchMutationPayload } from "./events.js";

const id = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export class StaleResearchGraphError extends Error {
  readonly code = "STALE_GRAPH";
  constructor(readonly expected: number, readonly current: number) {
    super(`stale research graph: commit is based on revision ${expected}, current revision is ${current}`);
  }
}

export function validateAndProjectCommit(snapshot: AutoResearchSnapshot, input: unknown): { commit: ReturnType<typeof researchCommitSchema.parse>; mutation: ResearchMutationPayload } {
  const commit = researchCommitSchema.parse(input);
  if (commit.research_id !== snapshot.research_id) throw new Error("research commit targets a different research");
  if (commit.base_revision !== snapshot.revision) throw new StaleResearchGraphError(commit.base_revision, snapshot.revision);
  if (new Set(commit.actions.map((action) => action.action_id)).size !== commit.actions.length) throw new Error("research action_id values must be unique within a commit");
  const now = new Date().toISOString();
  const existing = new Map(snapshot.nodes.map((node) => [node.node_id, node]));
  const actionNodes = new Map<string, ResearchNode>();
  const created: ResearchNode[] = [];
  const updated = new Map<string, ResearchNode>();
  const edges: ResearchEdge[] = [];
  const claims: ResearchClaim[] = [];
  let status = snapshot.status;
  let activity: string | null | undefined;
  let stopReason: string | null | undefined;

  const resolveRef = (ref: ResearchNodeRef): ResearchNode => {
    const node = "node_id" in ref ? existing.get(ref.node_id) ?? updated.get(ref.node_id) : actionNodes.get(ref.action_id);
    if (!node) throw new Error(`research node reference cannot be resolved: ${JSON.stringify(ref)}`);
    return node;
  };
  const addEdge = (from: string, to: string, relation: ResearchEdge["relation"]) => edges.push({ edge_id: id("edge"), from, to, relation, created_at: now });
  const addNode = (action: ResearchAction, node: ResearchNode) => { created.push(node); actionNodes.set(action.action_id, node); existing.set(node.node_id, node); };

  for (const action of commit.actions) {
    if (action.type === "question.add") {
      addNode(action, { node_id: id("node"), kind: "question", question: action.question, status: "ready", priority: 0, created_at: now, updated_at: now });
    } else if (action.type === "hypothesis.add") {
      const node: ResearchNode = { node_id: id("node"), kind: "hypothesis", statement: action.statement, assumptions: action.assumptions, status: "ready", priority: 0, created_at: now, updated_at: now };
      addNode(action, node);
      for (const ref of action.parent_refs) addEdge(resolveRef(ref).node_id, node.node_id, "decomposes");
    } else if (action.type === "experiment.propose") {
      const hypothesis = resolveRef(action.hypothesis_ref);
      if (hypothesis.kind !== "hypothesis") throw new Error("experiment hypothesis_ref must resolve to a hypothesis node");
      const node: ResearchNode = { node_id: id("node"), kind: "experiment", hypothesis_id: hypothesis.node_id, spec: action.spec, candidate_id: null, execution_id: null, result_node_id: null, result: null, status: "ready", priority: action.priority, created_at: now, updated_at: now };
      addNode(action, node); addEdge(hypothesis.node_id, node.node_id, "tests");
    } else if (action.type === "literature.request") {
      const node: ResearchNode = { node_id: id("node"), kind: "literature", question: action.question, findings: [], status: "ready", priority: action.priority, created_at: now, updated_at: now };
      addNode(action, node);
      for (const ref of action.parent_refs) addEdge(resolveRef(ref).node_id, node.node_id, "depends_on");
    } else if (action.type === "node.prioritize") {
      const node = existing.get(action.node_id);
      if (!node) throw new Error(`cannot prioritize missing node ${action.node_id}`);
      updated.set(node.node_id, { ...node, priority: action.priority, updated_at: now });
    } else if (action.type === "branch.close") {
      const node = existing.get(action.node_id);
      if (!node) throw new Error(`cannot close missing node ${action.node_id}`);
      if (["running", "succeeded", "verified"].includes(node.status)) throw new Error(`cannot close ${node.status} node ${node.node_id}`);
      updated.set(node.node_id, { ...node, status: "rejected", updated_at: now });
      activity = action.reason;
    } else if (action.type === "verification.request") {
      const target = existing.get(action.target_node_id);
      if (!target) throw new Error(`cannot verify missing node ${action.target_node_id}`);
      const node: ResearchNode = { node_id: id("node"), kind: "verification", target_node_id: target.node_id, verdict: "pending", details: {}, status: "ready", priority: action.priority, created_at: now, updated_at: now };
      addNode(action, node); addEdge(target.node_id, node.node_id, "derived_from");
    } else if (action.type === "synthesis.request") {
      for (const targetNodeId of action.target_node_ids) if (!existing.has(targetNodeId)) throw new Error(`cannot synthesize missing node ${targetNodeId}`);
      const node: ResearchNode = { node_id: id("node"), kind: "synthesis", summary: "", claim_ids: [], status: "ready", priority: action.priority, created_at: now, updated_at: now };
      addNode(action, node);
      for (const targetNodeId of action.target_node_ids) addEdge(targetNodeId, node.node_id, "derived_from");
    } else if (action.type === "user_input.request") {
      const node: ResearchNode = { node_id: id("node"), kind: "decision", reason: action.reason, options: action.options, resolution: null, status: "ready", priority: Number.MAX_SAFE_INTEGER, created_at: now, updated_at: now };
      addNode(action, node); status = "input_required"; activity = action.reason;
    } else if (action.type === "claim.propose") {
      claims.push({ claim_id: id("claim"), statement: action.statement, scope: action.scope, confidence: action.confidence, status: "proposed", created_at: now, updated_at: now });
    } else if (action.type === "research.stop_recommended") {
      stopReason = `supervisor_recommended:${action.reason}`;
      activity = action.reason;
    }
  }
  return {
    commit,
    mutation: {
      nodes_created: created,
      nodes_updated: [...updated.values()],
      edges_created: edges,
      claims_created: claims,
      status,
      ...(activity !== undefined ? { current_activity: activity } : {}),
      ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    },
  };
}
