import { randomUUID } from "node:crypto";
import type { AutoResearchSnapshot, ClaimEvidence, ResearchClaim, ResearchEdge, ResearchEvidence, ResearchNode } from "@pi-science/contracts";
import { emitResearchEvent } from "../events.js";
import type { ExperimentExecutionHandle, ResearchExperimentExecutor } from "../executors/experiment-executor.js";
import type { ResearchWorker, ResearchWorkerResult } from "../executors/pi-research-worker.js";
import { ResearchGraphStore } from "../graph/store.js";
import { StaleResearchGraphError } from "../graph/validator.js";
import type { ExperimentMaterializer } from "../materializers/pi-experiment-materializer.js";
import type { ResearchSupervisor } from "../supervisors/pi-supervisor-runner.js";

const terminalResearch = new Set(["completed", "failed", "cancelled"]);
const executableKinds = new Set(["literature", "experiment", "analysis", "verification", "synthesis"]);
const declarativeKinds = new Set(["question", "hypothesis"]);
const id = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export class ResearchOrchestrator {
  private readonly driving = new Map<string, Promise<void>>();
  private readonly nodeTasks = new Map<string, Promise<void>>();
  private readonly supervisorTasks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    readonly store: ResearchGraphStore,
    private readonly supervisor: ResearchSupervisor,
    private readonly materializer: ExperimentMaterializer,
    private readonly experiments: ResearchExperimentExecutor,
    private readonly workers: ResearchWorker,
  ) {}

  async create(cwd: string, input: unknown) {
    const snapshot = await this.store.create(cwd, input);
    emitResearchEvent(cwd, snapshot, "research.created", { snapshot });
    return snapshot;
  }

  list(cwd: string) { return this.store.list(cwd); }
  detail(cwd: string, researchId: string) { return this.store.snapshot(cwd, researchId); }
  async hasActive(cwd: string) { return (await this.list(cwd)).some((item) => !terminalResearch.has(item.status)); }

  async start(cwd: string, researchId: string) {
    const snapshot = await this.store.update(cwd, researchId, "research.started", (current) => {
      if (!["draft", "paused", "input_required"].includes(current.status)) throw new Error(`cannot start ${current.status} research`);
      return { status: "running", started_at: current.started_at ?? new Date().toISOString(), stop_reason: null, current_activity: "Planning the next research epoch" };
    }, { producer: "user" });
    emitResearchEvent(cwd, snapshot, "research.started", { snapshot }); this.resume(cwd, researchId); return snapshot;
  }

  async pause(cwd: string, researchId: string) {
    const snapshot = await this.store.update(cwd, researchId, "research.mutated", (current) => {
      if (current.status !== "running") throw new Error(`cannot pause ${current.status} research`);
      return { status: "pausing", current_activity: "Pausing after active operations settle" };
    }, { producer: "user" });
    emitResearchEvent(cwd, snapshot, "research.activity.changed", { activity: snapshot.current_activity });
    this.resume(cwd, researchId); return snapshot;
  }

  async resumeResearch(cwd: string, researchId: string) {
    const snapshot = await this.store.update(cwd, researchId, "research.mutated", (current) => {
      if (current.status !== "paused") throw new Error(`cannot resume ${current.status} research`);
      return { status: "running", current_activity: "Resuming research" };
    }, { producer: "user" });
    emitResearchEvent(cwd, snapshot, "research.activity.changed", { activity: snapshot.current_activity });
    this.resume(cwd, researchId); return snapshot;
  }

  async cancel(cwd: string, researchId: string) {
    const current = await this.detail(cwd, researchId);
    if (!current) throw new Error("research not found");
    await Promise.allSettled(current.nodes.flatMap((node) => node.kind === "experiment" && node.status === "running" && executionHandle(node) ? [this.experiments.cancel(cwd, executionHandle(node)!)] : []));
    await Promise.allSettled([this.supervisor.cancelResearch(researchId), this.materializer.cancelResearch(researchId), this.workers.cancelResearch(researchId)]);
    const snapshot = await this.store.mutate(cwd, researchId, "research.cancelled", { status: "cancelled", stop_reason: "cancelled_by_user", completed_at: new Date().toISOString(), current_activity: null }, { producer: "user" });
    emitResearchEvent(cwd, snapshot, "research.completed", { reason: snapshot.stop_reason }); return snapshot;
  }

  async updateConstraints(cwd: string, researchId: string, constraints: string[]) {
    const snapshot = await this.store.mutate(cwd, researchId, "research.constraint.updated", { constraints, current_activity: "User constraints updated; replanning" }, { producer: "user" });
    emitResearchEvent(cwd, snapshot, "research.progress.updated", { constraints }); this.resume(cwd, researchId); return snapshot;
  }

  async resolveInput(cwd: string, researchId: string, nodeId: string, resolution: string) {
    const snapshot = await this.store.update(cwd, researchId, "research.input.resolved", (current) => {
      const node = current.nodes.find((item) => item.node_id === nodeId);
      if (!node || node.kind !== "decision") throw new Error("decision node not found");
      return { nodes_updated: [{ ...node, resolution, status: "succeeded", updated_at: new Date().toISOString() }], status: "running", current_activity: "User decision received; replanning" };
    }, { producer: "user" });
    emitResearchEvent(cwd, snapshot, "research.progress.updated", { resolution }, { node_id: nodeId });
    this.resume(cwd, researchId); return snapshot;
  }

  resume(cwd: string, researchId: string): void {
    const key = `${cwd}\0${researchId}`;
    if (this.closed || this.driving.has(key)) return;
    const task = this.drive(cwd, researchId).finally(() => this.driving.delete(key));
    this.driving.set(key, task);
  }

  async reconcile(cwd: string): Promise<void> {
    for (const snapshot of await this.list(cwd)) if (["running", "pausing"].includes(snapshot.status)) this.resume(cwd, snapshot.research_id);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([this.supervisor.shutdown(), this.materializer.shutdown(), this.workers.shutdown()]);
    await Promise.allSettled([...this.nodeTasks.values(), ...this.supervisorTasks.values(), ...this.driving.values()]);
  }

  private async drive(cwd: string, researchId: string): Promise<void> {
    for (;;) {
      if (this.closed) return;
      let snapshot = await this.detail(cwd, researchId);
      if (!snapshot || terminalResearch.has(snapshot.status) || snapshot.status === "paused" || snapshot.status === "input_required") return;
      if (snapshot.status === "pausing") {
        if (await this.reconcileExperiments(cwd, snapshot)) continue;
        if (this.activeCount(cwd, snapshot) === 0) {
          const paused = await this.store.mutate(cwd, researchId, "research.mutated", { status: "paused", current_activity: null });
          emitResearchEvent(cwd, paused, "research.snapshot", { snapshot: paused }); return;
        }
        await delay(500); continue;
      }
      const reconciled = await this.reconcileExperiments(cwd, snapshot);
      if (reconciled) continue;
      snapshot = (await this.detail(cwd, researchId))!;
      const declarative = snapshot.nodes.filter((node) => declarativeKinds.has(node.kind) && ["proposed", "ready"].includes(node.status));
      if (declarative.length) {
        await this.store.update(cwd, researchId, "research.mutated", () => ({ nodes_updated: declarative.map((node) => ({ ...node, status: "succeeded", updated_at: new Date().toISOString() })) }));
        continue;
      }
      const reason = stopReason(snapshot);
      if (reason && this.activeCount(cwd, snapshot) === 0) {
        if (!snapshot.nodes.some((node) => node.kind === "synthesis" && node.status === "succeeded")) {
          if (!snapshot.nodes.some((node) => node.kind === "synthesis" && ["ready", "running"].includes(node.status))) {
            await this.ensureSynthesis(cwd, snapshot, reason); continue;
          }
        } else {
          await this.complete(cwd, snapshot, reason); return;
        }
      }
      const launched = this.schedule(cwd, snapshot);
      if (launched > 0) { await delay(100); continue; }
      if (this.activeCount(cwd, snapshot) > 0) { await delay(500); continue; }
      if (!this.supervisorTasks.has(`${cwd}\0${researchId}`)) this.launchSupervisor(cwd, snapshot);
      await delay(250);
    }
  }

  private schedule(cwd: string, snapshot: AutoResearchSnapshot): number {
    const capacity = Math.max(0, snapshot.budget.max_parallel - this.activeCount(cwd, snapshot));
    if (!capacity) return 0;
    let experimentSlots = Math.max(0, snapshot.budget.max_experiments - snapshot.usage.experiments_started);
    const ready = snapshot.nodes
      .filter((node) => node.status === "ready" && executableKinds.has(node.kind) && dependenciesSatisfied(snapshot, node))
      .sort((a, b) => b.priority - a.priority)
      .filter((node) => node.kind !== "experiment" || experimentSlots-- > 0)
      .slice(0, capacity);
    for (const node of ready) this.launchNode(cwd, snapshot.research_id, node.node_id);
    return ready.length;
  }

  private launchNode(cwd: string, researchId: string, nodeId: string): void {
    const key = `${cwd}\0${researchId}\0${nodeId}`;
    if (this.nodeTasks.has(key)) return;
    const task = this.runNode(cwd, researchId, nodeId).catch((error) => this.failNode(cwd, researchId, nodeId, error)).finally(() => { this.nodeTasks.delete(key); this.resume(cwd, researchId); });
    this.nodeTasks.set(key, task);
  }

  private async runNode(cwd: string, researchId: string, nodeId: string): Promise<void> {
    let snapshot = await this.store.update(cwd, researchId, "research.mutated", (current) => {
      const node = requireNode(current, nodeId);
      if (node.kind === "experiment" && current.usage.experiments_started >= current.budget.max_experiments) throw new Error("experiment budget exhausted before reservation");
      const experimentsStarted = current.usage.experiments_started + (node.kind === "experiment" ? 1 : 0);
      return { nodes_updated: [{ ...node, status: "running", updated_at: new Date().toISOString() }], usage: { ...current.usage, experiments_started: experimentsStarted }, current_activity: `Running ${node.kind} node ${node.node_id}` };
    });
    emitResearchEvent(cwd, snapshot, "research.activity.changed", { activity: snapshot.current_activity }, { node_id: nodeId });
    const node = requireNode(snapshot, nodeId);
    if (node.kind === "experiment") {
      const materialized = await this.materializer.materialize(cwd, snapshot, nodeId);
      snapshot = (await this.detail(cwd, researchId))!;
      if (snapshot.status !== "running") return;
      const currentNode = requireNode(snapshot, nodeId);
      if (currentNode.kind !== "experiment") throw new Error("experiment node changed kind");
      const handle = await this.experiments.start(cwd, researchId, currentNode, materialized.proposal);
      await this.store.update(cwd, researchId, "research.mutated", (current) => {
        const latest = requireNode(current, nodeId);
        if (latest.kind !== "experiment") throw new Error("experiment node changed kind");
        return { nodes_updated: [{ ...latest, candidate_id: handle.candidate_id, execution_id: handle.job_id, result: { handle }, updated_at: new Date().toISOString() }], usage: addUsage(current, materialized.model_tokens, materialized.cost_usd) };
      });
      return;
    }
    const result = await this.workers.run(cwd, snapshot, node);
    const updated = await this.store.update(cwd, researchId, "research.mutated", (current) => workerMutation(current, requireNode(current, nodeId), result));
    emitResearchEvent(cwd, updated, "research.finding.created", { summary: result.summary, claims: result.claims }, { node_id: nodeId });
  }

  private async reconcileExperiments(cwd: string, snapshot: AutoResearchSnapshot): Promise<boolean> {
    for (const node of snapshot.nodes) {
      if (node.kind !== "experiment" || node.status !== "running") continue;
      const key = `${cwd}\0${snapshot.research_id}\0${node.node_id}`;
      if (this.nodeTasks.has(key)) continue;
      const handle = executionHandle(node);
      if (!handle) {
        await this.failNode(cwd, snapshot.research_id, node.node_id, new Error("experiment materialization was interrupted before job publication")); return true;
      }
      const state = await this.experiments.reconcile(cwd, node, handle);
      if (state.status === "running") continue;
      if (state.status === "failed") { await this.failNode(cwd, snapshot.research_id, node.node_id, new Error(state.error)); return true; }
      const updated = await this.store.update(cwd, snapshot.research_id, "research.mutated", (current) => {
        const latest = requireNode(current, node.node_id);
        if (latest.kind !== "experiment") throw new Error("experiment node changed kind");
        const evidence: ResearchEvidence = { evidence_id: id("evidence"), kind: "execution", locator: { research_id: current.research_id, node_id: node.node_id, ...state.result }, digest: null, created_at: new Date().toISOString() };
        const best = chooseBest(current, state.result);
        return { nodes_updated: [{ ...latest, status: "succeeded", result: state.result, updated_at: new Date().toISOString() }], evidence_created: [evidence], usage: { ...current.usage, experiments_completed: current.usage.experiments_completed + 1 }, best_result: best, current_activity: `Experiment ${node.node_id} completed` };
      });
      emitResearchEvent(cwd, updated, "research.best_result.updated", { best_result: updated.best_result }, { node_id: node.node_id, execution_id: handle.job_id }); return true;
    }
    return false;
  }

  private launchSupervisor(cwd: string, snapshot: AutoResearchSnapshot): void {
    const key = `${cwd}\0${snapshot.research_id}`;
    const task = this.supervisor.decide(cwd, snapshot).then(async (decision) => {
      try {
        await this.store.commit(cwd, decision.commit);
        const updated = await this.store.update(cwd, snapshot.research_id, "research.mutated", (current) => ({ usage: addUsage(current, decision.model_tokens, decision.cost_usd), current_activity: "Research plan updated" }));
        emitResearchEvent(cwd, updated, updated.status === "input_required" ? "research.input.required" : "research.progress.updated", { snapshot: updated });
      } catch (error) {
        if (!(error instanceof StaleResearchGraphError)) throw error;
      }
    }).catch(async (error) => {
      const current = await this.detail(cwd, snapshot.research_id);
      if (current && !terminalResearch.has(current.status)) {
        const failed = await this.store.mutate(cwd, snapshot.research_id, "research.failed", { status: "failed", stop_reason: String(error), completed_at: new Date().toISOString(), current_activity: null });
        emitResearchEvent(cwd, failed, "research.failed", { error: String(error) });
      }
    }).finally(() => { this.supervisorTasks.delete(key); this.resume(cwd, snapshot.research_id); });
    this.supervisorTasks.set(key, task);
  }

  private async failNode(cwd: string, researchId: string, nodeId: string, error: unknown): Promise<void> {
    const snapshot = await this.store.update(cwd, researchId, "research.mutated", (current) => {
      const node = requireNode(current, nodeId);
      // A failed runtime (timeout, identity mismatch, worker error) still
      // consumed model tokens; carry its spend into the research usage so
      // budgets reflect what actually ran.
      const usage = errorUsageDelta(error);
      return {
        nodes_updated: [{ ...node, status: "failed", updated_at: new Date().toISOString(), ...(node.kind === "experiment" ? { result: { error: String(error) } } : {}) }],
        usage: usage ? addUsage(current, usage.model_tokens, usage.cost_usd) : current.usage,
        current_activity: `${node.kind} node failed: ${String(error)}`,
      };
    });
    emitResearchEvent(cwd, snapshot, "research.progress.updated", { error: String(error) }, { node_id: nodeId });
  }

  private async complete(cwd: string, snapshot: AutoResearchSnapshot, reason: string): Promise<void> {
    const activeWallMs = snapshot.started_at ? Math.max(snapshot.usage.active_wall_ms, Date.now() - Date.parse(snapshot.started_at)) : snapshot.usage.active_wall_ms;
    const completed = await this.store.mutate(cwd, snapshot.research_id, "research.completed", { status: "completed", stop_reason: reason, completed_at: new Date().toISOString(), current_activity: null, usage: { ...snapshot.usage, active_wall_ms: activeWallMs } });
    emitResearchEvent(cwd, completed, "research.completed", { reason, snapshot: completed });
  }

  private async ensureSynthesis(cwd: string, snapshot: AutoResearchSnapshot, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const targets = snapshot.nodes.filter((node) => ["succeeded", "verified"].includes(node.status) && node.kind !== "synthesis");
    const synthesis: Extract<ResearchNode, { kind: "synthesis" }> = { node_id: id("node"), kind: "synthesis", summary: "", claim_ids: [], status: "ready", priority: Number.MAX_SAFE_INTEGER, created_at: now, updated_at: now };
    const edges: ResearchEdge[] = targets.map((target) => ({ edge_id: id("edge"), from: target.node_id, to: synthesis.node_id, relation: "derived_from", created_at: now }));
    const updated = await this.store.mutate(cwd, snapshot.research_id, "research.mutated", { nodes_created: [synthesis], edges_created: edges, current_activity: `Synthesizing final result: ${reason}` });
    emitResearchEvent(cwd, updated, "research.activity.changed", { activity: updated.current_activity }, { node_id: synthesis.node_id });
  }

  private activeCount(cwd: string, snapshot: AutoResearchSnapshot): number {
    const prefix = `${cwd}\0${snapshot.research_id}\0`;
    const local = [...this.nodeTasks.keys()].filter((key) => key.startsWith(prefix)).length;
    const external = snapshot.nodes.filter((node) => node.status === "running" && node.kind === "experiment" && executionHandle(node)).length;
    return local + external + (this.supervisorTasks.has(`${cwd}\0${snapshot.research_id}`) ? 1 : 0);
  }
}

function requireNode(snapshot: AutoResearchSnapshot, nodeId: string): ResearchNode {
  const node = snapshot.nodes.find((item) => item.node_id === nodeId);
  if (!node) throw new Error(`research node not found: ${nodeId}`);
  return node;
}

function executionHandle(node: Extract<ResearchNode, { kind: "experiment" }>): ExperimentExecutionHandle | null {
  const value = node.result && typeof node.result === "object" ? (node.result as Record<string, unknown>).handle : null;
  if (!value || typeof value !== "object") return null;
  const handle = value as Partial<ExperimentExecutionHandle>;
  return typeof handle.candidate_id === "string" && typeof handle.job_id === "string" && typeof handle.run_id === "string" && typeof handle.outputs_dir === "string" ? handle as ExperimentExecutionHandle : null;
}

function dependenciesSatisfied(snapshot: AutoResearchSnapshot, node: ResearchNode): boolean {
  const dependencies = snapshot.edges.filter((edge) => edge.to === node.node_id && edge.relation === "depends_on");
  return dependencies.every((edge) => ["succeeded", "verified"].includes(snapshot.nodes.find((candidate) => candidate.node_id === edge.from)?.status ?? ""));
}

function addUsage(snapshot: AutoResearchSnapshot, tokens: number, cost: number) {
  return { ...snapshot.usage, model_tokens: snapshot.usage.model_tokens + tokens, cost_usd: snapshot.usage.cost_usd + cost };
}

function workerMutation(snapshot: AutoResearchSnapshot, node: ResearchNode, result: ResearchWorkerResult) {
  const now = new Date().toISOString();
  const claims: ResearchClaim[] = result.claims.map((claim) => ({ claim_id: id("claim"), statement: claim.statement, scope: claim.scope, confidence: claim.confidence, status: node.kind === "verification" && result.verdict === "verified" ? "verified" : "proposed", created_at: now, updated_at: now }));
  const evidence: ResearchEvidence = { evidence_id: id("evidence"), kind: "observation", locator: { research_id: snapshot.research_id, node_id: node.node_id, node_kind: node.kind, summary: result.summary, findings: result.findings }, digest: null, created_at: now };
  const sources = node.kind === "synthesis" && snapshot.evidence.length > 0 ? snapshot.evidence : [evidence];
  const links: ClaimEvidence[] = claims.flatMap((claim) => sources.map((source) => ({ claim_id: claim.claim_id, evidence_id: source.evidence_id, relation: node.kind === "synthesis" ? "derives_from" as const : "supports" as const, strength: claim.confidence })));
  let updated: ResearchNode;
  if (node.kind === "literature") updated = { ...node, findings: result.findings, status: "succeeded", updated_at: now };
  else if (node.kind === "analysis") updated = { ...node, findings: result.findings, status: "succeeded", updated_at: now };
  else if (node.kind === "verification") updated = { ...node, verdict: result.verdict ?? "failed", details: { summary: result.summary, findings: result.findings }, status: result.verdict === "verified" ? "verified" : "failed", updated_at: now };
  else if (node.kind === "synthesis") updated = { ...node, summary: result.summary, claim_ids: claims.map((claim) => claim.claim_id), status: "succeeded", updated_at: now };
  else throw new Error(`unsupported worker node: ${node.kind}`);
  return { nodes_updated: [updated], claims_created: claims, evidence_created: [evidence], claim_evidence_created: links, usage: addUsage(snapshot, result.model_tokens, result.cost_usd), current_activity: `${node.kind} node ${node.node_id} completed` };
}

function chooseBest(snapshot: AutoResearchSnapshot, result: Record<string, unknown>): Record<string, unknown> {
  const current = snapshot.best_result;
  if (!current) return result;
  const targets = Object.entries(snapshot.target_metrics);
  const name = targets[0]?.[0] ?? Object.keys((result.metrics as Record<string, unknown> | undefined) ?? {})[0];
  if (!name) return current;
  const direction = targets[0]?.[1].direction ?? "maximize";
  const nextValue = Number((result.metrics as Record<string, unknown> | undefined)?.[name]);
  const currentValue = Number((current.metrics as Record<string, unknown> | undefined)?.[name]);
  if (!Number.isFinite(nextValue)) return current;
  if (!Number.isFinite(currentValue) || (direction === "maximize" ? nextValue > currentValue : nextValue < currentValue)) return result;
  return current;
}

function stopReason(snapshot: AutoResearchSnapshot): string | null {
  if (snapshot.started_at && Date.now() - Date.parse(snapshot.started_at) >= snapshot.budget.max_wall_seconds * 1000) return "wall_time_budget_exhausted";
  if (snapshot.usage.experiments_started >= snapshot.budget.max_experiments && !snapshot.nodes.some((node) => node.status === "running")) return "experiment_budget_exhausted";
  if (snapshot.budget.max_model_tokens !== null && snapshot.usage.model_tokens >= snapshot.budget.max_model_tokens) return "model_token_budget_exhausted";
  if (snapshot.budget.max_cost_usd !== null && snapshot.usage.cost_usd >= snapshot.budget.max_cost_usd) return "cost_budget_exhausted";
  if (snapshot.stop_reason?.startsWith("supervisor_recommended:")) return snapshot.stop_reason;
  const metrics = snapshot.best_result?.metrics as Record<string, unknown> | undefined;
  if (metrics && Object.entries(snapshot.target_metrics).length > 0 && Object.entries(snapshot.target_metrics).every(([name, target]) => {
    const value = Number(metrics[name]); return Number.isFinite(value) && (target.direction === "maximize" ? value >= target.value : value <= target.value);
  })) return "target_metrics_reached";
  return null;
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Extract model spend attached to a failed research operation (runtime
 *  failures carry { model_tokens, cost_usd }). Returns null when the error
 *  does not report usage, so accounting stays additive and opt-in. */
function errorUsageDelta(error: unknown): { model_tokens: number; cost_usd: number } | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { model_tokens?: unknown; cost_usd?: unknown };
  if (typeof record.model_tokens !== "number" && typeof record.cost_usd !== "number") return null;
  return {
    model_tokens: typeof record.model_tokens === "number" ? record.model_tokens : 0,
    cost_usd: typeof record.cost_usd === "number" ? record.cost_usd : 0,
  };
}
