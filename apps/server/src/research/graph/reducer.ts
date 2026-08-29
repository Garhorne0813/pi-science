import { autoResearchSnapshotSchema, type AutoResearchSnapshot, type ResearchNode } from "@pi-science/contracts";
import type { ResearchCreatedPayload, ResearchGraphEvent, ResearchMutationPayload } from "./events.js";

export function reduceResearchGraph(events: ResearchGraphEvent[], researchId: string): AutoResearchSnapshot | null {
  let snapshot: AutoResearchSnapshot | null = null;
  for (const event of events) {
    if (event.research_id !== researchId) continue;
    if (event.type === "research.created") {
      const payload = event.payload as ResearchCreatedPayload;
      snapshot = autoResearchSnapshotSchema.parse({
        schema_version: 1,
        research_id: researchId,
        project_id: payload.project_id,
        origin_session_id: payload.origin_session_id,
        origin_message_id: payload.origin_message_id,
        revision: event.revision,
        title: payload.title,
        objective: payload.objective,
        status: "draft",
        constraints: payload.constraints,
        budget: payload.budget,
        usage: {},
        target_metrics: payload.target_metrics,
        nodes: [payload.question],
        edges: [],
        claims: [],
        evidence: [],
        claim_evidence: [],
        current_activity: null,
        best_result: null,
        report_path: null,
        stop_reason: null,
        created_at: event.timestamp,
        updated_at: event.timestamp,
        started_at: null,
        completed_at: null,
      });
      continue;
    }
    if (!snapshot || event.revision <= snapshot.revision) continue;
    snapshot = applyMutation(snapshot, event.payload as ResearchMutationPayload, event);
  }
  return snapshot;
}

function applyMutation(snapshot: AutoResearchSnapshot, payload: ResearchMutationPayload, event: ResearchGraphEvent): AutoResearchSnapshot {
  const nodes = new Map(snapshot.nodes.map((node) => [node.node_id, node]));
  for (const node of payload.nodes_created ?? []) nodes.set(node.node_id, node);
  for (const node of payload.nodes_updated ?? []) nodes.set(node.node_id, node);
  const edges = new Map(snapshot.edges.map((edge) => [edge.edge_id, edge]));
  for (const edge of payload.edges_created ?? []) edges.set(edge.edge_id, edge);
  const claims = new Map(snapshot.claims.map((claim) => [claim.claim_id, claim]));
  for (const claim of payload.claims_created ?? []) claims.set(claim.claim_id, claim);
  const evidence = new Map(snapshot.evidence.map((item) => [item.evidence_id, item]));
  for (const item of payload.evidence_created ?? []) evidence.set(item.evidence_id, item);
  const links = new Map(snapshot.claim_evidence.map((item) => [`${item.claim_id}\0${item.evidence_id}\0${item.relation}`, item]));
  for (const item of payload.claim_evidence_created ?? []) links.set(`${item.claim_id}\0${item.evidence_id}\0${item.relation}`, item);
  const usage = { ...snapshot.usage };
  for (const [key, value] of Object.entries(payload.usage ?? {})) {
    if (typeof value === "number") (usage as Record<string, number>)[key] = value;
  }
  return autoResearchSnapshotSchema.parse({
    ...snapshot,
    revision: event.revision,
    nodes: [...nodes.values()] as ResearchNode[],
    edges: [...edges.values()],
    claims: [...claims.values()],
    evidence: [...evidence.values()],
    claim_evidence: [...links.values()],
    usage,
    ...(payload.status !== undefined ? { status: payload.status } : {}),
    ...(payload.current_activity !== undefined ? { current_activity: payload.current_activity } : {}),
    ...(payload.best_result !== undefined ? { best_result: payload.best_result } : {}),
    ...(payload.report_path !== undefined ? { report_path: payload.report_path } : {}),
    ...(payload.stop_reason !== undefined ? { stop_reason: payload.stop_reason } : {}),
    ...(payload.started_at !== undefined ? { started_at: payload.started_at } : {}),
    ...(payload.completed_at !== undefined ? { completed_at: payload.completed_at } : {}),
    ...(payload.constraints !== undefined ? { constraints: payload.constraints } : {}),
    updated_at: event.timestamp,
  });
}

export function listResearchGraphs(events: ResearchGraphEvent[]): AutoResearchSnapshot[] {
  const ids = [...new Set(events.map((event) => event.research_id))];
  return ids.flatMap((id) => {
    const snapshot = reduceResearchGraph(events, id);
    return snapshot ? [snapshot] : [];
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
