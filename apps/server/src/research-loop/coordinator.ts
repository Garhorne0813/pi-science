import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  createResearchLoopSchema,
  evaluatorSpecSchema,
  researchAgentResultSchema,
  researchLoopSchema,
  type EvaluatorSpec,
  type ResearchLoop,
} from "@pi-science/contracts";
import type { JobCoordinator, JobRecord } from "../runtime/jobs/job-coordinator.js";
import { metadataRoot } from "../storage/persistence.js";
import { findBashExecutable } from "../support/platform-utils.js";
import { snapshotCandidate, within } from "./candidate-snapshot.js";
import { listReducedLoops, reduceResearchRecords } from "./reducer.js";
import { ResearchRepository } from "./repository.js";
import { activeWallMs, stopReason } from "./stop-policy.js";
import type { AgentRunUsage, ResearchCandidate, ResearchSnapshot, ResearchSubagentRunner } from "./types.js";

const terminalLoops = new Set(["completed", "failed", "cancelled"]);
const terminalJobs = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const DRIVE_POLL_MIN_MS = 100;
const DRIVE_POLL_MAX_MS = 2_000;

export class ResearchLoopCoordinator {
  private readonly driving = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly jobs: JobCoordinator, private readonly runner: ResearchSubagentRunner) {}

  repository(cwd: string) { return new ResearchRepository(cwd); }

  async create(cwd: string, input: unknown): Promise<ResearchLoop> {
    const parsed = createResearchLoopSchema.parse(input);
    const now = new Date().toISOString();
    const loop = researchLoopSchema.parse({
      loop_id: `loop-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      revision: 0,
      title: parsed.title,
      objective: parsed.objective,
      task_type: parsed.task_type,
      status: "draft",
      evaluator_ref: parsed.evaluator_ref ?? null,
      budget: { max_candidates: 20, max_wall_seconds: 7200, max_parallel: 1, ...parsed.budget },
      stop_conditions: { target_metrics: {}, patience: 5, min_improvement: 0, ...parsed.stop_conditions },
      constraints: parsed.constraints,
      created_by: parsed.created_by,
      created_at: now,
      updated_at: now,
      started_at: null,
      active_wall_ms: 0,
      stop_reason: null,
      current_operation_id: null,
    });
    await this.repository(cwd).append("loop.created", loop, { loop_id: loop.loop_id, producer: parsed.created_by });
    return loop;
  }

  async registerEvaluator(cwd: string, input: unknown) {
    const evaluator = evaluatorSpecSchema.parse({ ...(input as object), created_at: new Date().toISOString() });
    const repository = this.repository(cwd);
    return repository.locked(async (records) => {
      const duplicate = records.some((row) => row.record_type === "evaluator.registered"
        && row.payload.evaluator_id === evaluator.evaluator_id && Number(row.payload.version) === evaluator.version);
      if (duplicate) throw new Error("evaluator version already exists");
      const record = await repository.appendUnlocked("evaluator.registered", evaluator, { producer: "user" });
      return { record_id: record.record_id, evaluator };
    });
  }

  async evaluators(cwd: string): Promise<EvaluatorSpec[]> {
    return (await this.repository(cwd).records()).flatMap((row) => {
      if (row.record_type !== "evaluator.registered") return [];
      const parsed = evaluatorSpecSchema.safeParse(row.payload);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async list(cwd: string) { return this.repository(cwd).loops(); }

  async hasActive(cwd: string): Promise<boolean> {
    return (await this.list(cwd)).some((loop) => ["running", "pausing", "cancelling"].includes(loop.status));
  }

  async detail(cwd: string, loopId: string) {
    const snapshot = await this.repository(cwd).snapshot(loopId);
    if (!snapshot.loop) return null;
    return { ...snapshot.loop, candidates: snapshot.candidates, operations: snapshot.operations, frontier: frontier(snapshot.candidates) };
  }

  async preflight(cwd: string, loopId: string) {
    const repository = this.repository(cwd);
    return repository.locked(async (records) => {
      const snapshot = reduceResearchRecords(records, loopId);
      const loop = requireLoop(snapshot);
      if (!["draft", "ready"].includes(loop.status)) throw new Error(`cannot preflight a ${loop.status} loop`);
      const blockers = evaluatorBlockers(records, loop);
      if (blockers.length) return { ok: false, blockers, loop };
      if (loop.status === "ready") return { ok: true, blockers: [], loop };
      const ready = nextLoop(loop, { status: "ready" });
      await repository.appendUnlocked("loop.state_changed", loopPayload(ready, "preflight_passed"), { loop_id: loopId });
      return { ok: true, blockers: [], loop: ready };
    });
  }

  async action(cwd: string, loopId: string, action: string): Promise<ResearchLoop> {
    const repository = this.repository(cwd);
    const updated = await repository.locked(async (records) => {
      const snapshot = reduceResearchRecords(records, loopId);
      const loop = requireLoop(snapshot);
      const transitions: Record<string, Record<string, ResearchLoop["status"]>> = {
        ready: { start: "running", cancel: "cancelled" },
        running: { pause: "pausing", cancel: "cancelling", complete: "completed" },
        pausing: { cancel: "cancelling" },
        paused: { resume: "running", cancel: "cancelled" },
        needs_attention: { resume: "running", cancel: "cancelled" },
        draft: { cancel: "cancelled" },
      };
      const status = transitions[loop.status]?.[action];
      if (!status) throw new Error(`invalid loop transition: ${loop.status} -> ${action}`);
      if (status === "running" && listReducedLoops(records).some((other) => other.loop_id !== loopId && ["running", "pausing", "cancelling"].includes(other.status))) {
        throw new Error("another research loop is already active in this workspace");
      }
      if (action === "start") {
        const blockers = evaluatorBlockers(records, loop);
        if (blockers.length) throw new Error(blockers.join("; "));
      }
      const pausing = ["pausing", "paused", "cancelling", "cancelled", "completed"].includes(status);
      const next = nextLoop(loop, {
        status,
        ...(status === "running" ? { started_at: new Date().toISOString(), stop_reason: null } : {}),
        ...(pausing ? { active_wall_ms: activeWallMs(loop), started_at: null } : {}),
        ...(terminalLoops.has(status) ? { stop_reason: `user_${action}` } : {}),
      });
      await repository.appendUnlocked("loop.state_changed", loopPayload(next, `user_${action}`), { loop_id: loopId });
      return next;
    });
    if (updated.status === "running") this.resume(cwd, loopId);
    if (["cancelling", "cancelled", "completed"].includes(updated.status)) await this.cancelActive(cwd, loopId);
    return (await this.repository(cwd).snapshot(loopId)).loop ?? updated;
  }

  resume(cwd: string, loopId: string): void {
    const key = `${resolve(cwd)}\0${loopId}`;
    if (this.closed || this.driving.has(key)) return;
    const drive = this.drive(cwd, loopId).finally(() => this.driving.delete(key));
    this.driving.set(key, drive);
  }

  async reconcile(cwd: string): Promise<void> {
    for (const loop of await this.list(cwd)) if (["running", "pausing", "cancelling"].includes(loop.status)) this.resume(cwd, loop.loop_id);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.runner.shutdown();
    await Promise.allSettled(this.driving.values());
  }

  private async drive(cwd: string, loopId: string): Promise<void> {
    // Waiting for an external job can last hours; back off while the event log is
    // quiet and snap back to a tight poll the moment it records anything.
    let wait = DRIVE_POLL_MIN_MS;
    let watermark = "";
    const idle = async () => { await delay(wait); wait = Math.min(wait * 2, DRIVE_POLL_MAX_MS); };
    for (;;) {
      if (this.closed) return;
      const snapshot = await this.repository(cwd).snapshot(loopId);
      const progress = `${snapshot.records.length}:${snapshot.records.at(-1)?.record_id ?? ""}`;
      if (progress !== watermark) { watermark = progress; wait = DRIVE_POLL_MIN_MS; }
      const loop = snapshot.loop;
      if (!loop || terminalLoops.has(loop.status) || loop.status === "paused" || loop.status === "needs_attention") return;
      if (loop.status === "cancelling") {
        if (await this.finishCancellation(cwd, snapshot)) return;
        await idle();
        continue;
      }
      if (loop.status === "pausing" && !hasActiveWork(snapshot)) { await this.finishPause(cwd, loop); return; }
      if (loop.status !== "running" && loop.status !== "pausing") return;
      try {
        if (await this.recoverInterruptedWork(cwd, snapshot)) continue;
        if (snapshot.operations.some((operation) => ["reserved", "started"].includes(operation.status))) {
          await idle();
          continue;
        }
        const progressed = await this.advance(cwd, snapshot);
        if (!progressed) await idle();
      } catch (error) {
        const latest = (await this.repository(cwd).snapshot(loopId)).loop;
        if (latest?.status === "cancelling" || latest?.status === "pausing") continue;
        if (latest?.status === "paused") return;
        await this.failLoop(cwd, loopId, error);
        return;
      }
    }
  }

  private async advance(cwd: string, snapshot: ResearchSnapshot): Promise<boolean> {
    const loop = requireLoop(snapshot);
    const reason = stopReason(snapshot);
    if (reason) { await this.completeLoop(cwd, loop, reason); return true; }

    const last = snapshot.candidates.at(-1);
    if (!last) {
      if (loop.status === "pausing") return false;
      await this.generateCandidate(cwd, snapshot);
      return true;
    }
    if (last.status === "proposed") { await this.executeCandidate(cwd, snapshot, last); return true; }
    if (last.status === "executing") return this.reconcileExecution(cwd, snapshot, last);
    if (last.status === "succeeded") { await this.evaluateCandidate(cwd, snapshot, last); return true; }
    if (["failed", "cancelled", "evaluated"].includes(last.status)) {
      const analyzed = snapshot.operations.some((operation) => operation.candidate_id === last.candidate_id && operation.phase === "analysis" && operation.status === "completed");
      if (!analyzed) { await this.analyzeCandidate(cwd, snapshot, last); return true; }
      if (loop.status === "pausing") return false;
      await this.generateCandidate(cwd, snapshot);
      return true;
    }
    return false;
  }

  private async generateCandidate(cwd: string, snapshot: ResearchSnapshot): Promise<void> {
    const loop = requireLoop(snapshot);
    const operationId = `op-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const repository = this.repository(cwd);
    // Loop snapshots intentionally contain only loop-scoped records. Evaluators
    // are workspace-scoped, so resolve the referenced immutable version from the
    // complete event log before building the supervisor context.
    const records = await repository.records();
    const evaluator = loop.evaluator_ref ? findEvaluator(records, loop.evaluator_ref.evaluator_id, loop.evaluator_ref.version) : null;
    await repository.locked(async (records) => {
      const current = reduceResearchRecords(records, loop.loop_id);
      if (requireLoop(current).status !== "running") throw new Error("research loop is not running");
      if (current.operations.some((operation) => operation.status === "reserved" || operation.status === "started")) throw new Error("research loop already has active work");
      const payload = { phase: "candidate", attempt: 1, idempotency_key: `candidate:${current.candidates.length + 1}` };
      await repository.appendUnlocked("agent.run_reserved", payload, { loop_id: loop.loop_id, operation_id: operationId });
      await repository.appendUnlocked("agent.run_started", payload, { loop_id: loop.loop_id, operation_id: operationId, run_id: operationId });
    });
    try {
      const result = await this.runner.run({
        operation_id: operationId,
        loop,
        phase: "candidate",
        context: {
          cwd,
          task_type: loop.task_type,
          objective: loop.objective,
          constraints: loop.constraints,
          evaluation: evaluator ? { metrics: evaluator.metrics, hard_checks: evaluator.hard_checks, stop_conditions: loop.stop_conditions } : null,
          candidates: compactCandidates(snapshot.candidates),
          budget_remaining: loop.budget.max_candidates - snapshot.candidates.length,
        },
      });
      const parsed = researchAgentResultSchema.parse(result.output);
      if (parsed.kind !== "candidate") throw new Error("candidate agent returned analysis output");
      const manifest = await snapshotCandidate(cwd, loop.loop_id, parsed.proposal);
      await repository.locked(async (records) => {
        const current = reduceResearchRecords(records, loop.loop_id);
        const status = requireLoop(current).status;
        await repository.appendUnlocked("agent.run_completed", { phase: "candidate", result: { run_id: result.run_id }, model_tokens: result.model_tokens, cost_usd: result.cost_usd }, { loop_id: loop.loop_id, operation_id: operationId, run_id: result.run_id });
        if (!["running", "pausing"].includes(status)) return;
        await repository.appendUnlocked("candidate.proposed", manifest, { loop_id: loop.loop_id, candidate_id: manifest.candidate_id, causation_id: operationId });
      });
    } catch (error) {
      await repository.append("agent.run_failed", { phase: "candidate", error: String(error), ...this.spent(operationId) }, { loop_id: loop.loop_id, operation_id: operationId, run_id: operationId });
      throw error;
    }
  }

  private async executeCandidate(cwd: string, snapshot: ResearchSnapshot, candidate: ResearchCandidate): Promise<void> {
    const loop = requireLoop(snapshot);
    const repository = this.repository(cwd);
    const operationId = `op-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await repository.locked(async (records) => {
      const current = reduceResearchRecords(records, loop.loop_id);
      const latest = current.candidates.find((item) => item.candidate_id === candidate.candidate_id);
      if (!latest || latest.status !== "proposed") throw new Error("candidate is no longer executable");
      if (current.operations.some((operation) => operation.candidate_id === candidate.candidate_id
        && operation.kind === "execution" && ["reserved", "started"].includes(operation.status))) {
        throw new Error("candidate execution is already active");
      }
      await repository.appendUnlocked("candidate.execution_reserved", { phase: "execution", attempt: 1, idempotency_key: `execute:${candidate.candidate_id}` }, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operationId });
    });

    const source = resolve(cwd, candidate.proposal.solution.path);
    const solutionsRoot = join(metadataRoot(cwd), "solutions");
    if (!within(solutionsRoot, source)) throw new Error("candidate source escapes solution root");
    const runId = `run-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const runRoot = join(metadataRoot(cwd), "runs", runId);
    const work = join(runRoot, "work");
    const outputs = join(runRoot, "outputs");
    await mkdir(runRoot, { recursive: true });
    await cp(source, work, { recursive: true, errorOnExist: true });
    await makeWritable(work);
    await mkdir(outputs, { recursive: true });
    const script = resolve(work, candidate.proposal.solution.entrypoint);
    if (!within(work, script)) throw new Error("candidate entrypoint escapes work directory");
    const bash = await findBashExecutable();
    if (!bash) throw new Error("Research loop candidates require bash. Install Git for Windows or set PI_SCIENCE_BASH_PATH to bash.exe.");
    const job = await this.jobs.submit(cwd, {
      command: [bash, script], execution_cwd: work, surface: "research-loop",
      env: { PI_SCIENCE_OUTPUT_DIR: outputs, PI_SCIENCE_RUN_ID: runId, PI_SCIENCE_CANDIDATE_ID: candidate.candidate_id },
      requirement: { timeout_seconds: Math.min(loop.budget.max_wall_seconds, 86_400) },
    });
    await this.publishSubmittedJob(cwd, loop.loop_id, candidate.candidate_id, operationId, job, "proposed", "candidate.execution_started", {
      phase: "execution", job_id: job.job_id, run_id: runId,
      work_dir: relative(cwd, work), outputs_dir: relative(cwd, outputs),
    }, "candidate.execution_failed", { phase: "execution", status: "cancelled", error: "loop finalized before execution job publication" });
  }

  private async reconcileExecution(cwd: string, snapshot: ResearchSnapshot, candidate: ResearchCandidate): Promise<boolean> {
    const jobId = String(candidate.execution.job_id ?? "");
    if (!jobId) throw new Error("executing candidate is missing job id");
    const job = await this.jobs.get(cwd, jobId);
    if (!job || !terminalJobs.has(job.status)) return false;
    const operation = snapshot.operations.find((item) => item.candidate_id === candidate.candidate_id && item.kind === "execution");
    await this.repository(cwd).locked(async (records) => {
      const current = reduceResearchRecords(records, snapshot.loop!.loop_id);
      const latest = current.candidates.find((item) => item.candidate_id === candidate.candidate_id);
      if (!latest || latest.status !== "executing") return;
      await this.repository(cwd).appendUnlocked("candidate.execution_finished", {
        phase: "execution", job_id: job.job_id, status: job.status, return_code: job.return_code ?? null,
        started_at: job.started_at ?? null, finished_at: job.ended_at ?? null,
        stdout_excerpt: job.stdout.slice(-4000), stderr_excerpt: job.stderr.slice(-4000),
      }, { loop_id: snapshot.loop!.loop_id, candidate_id: candidate.candidate_id, operation_id: operation?.operation_id, run_id: job.job_id });
    });
    return true;
  }

  private async evaluateCandidate(cwd: string, snapshot: ResearchSnapshot, candidate: ResearchCandidate): Promise<void> {
    const loop = requireLoop(snapshot);
    if (!loop.evaluator_ref) throw new Error("loop evaluator is missing");
    const records = await this.repository(cwd).records();
    const evaluator = findEvaluator(records, loop.evaluator_ref.evaluator_id, loop.evaluator_ref.version);
    if (!evaluator || evaluator.digest !== loop.evaluator_ref.digest) throw new Error("loop evaluator is unavailable or changed");
    const operationId = `op-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const repository = this.repository(cwd);
    await repository.locked(async (records) => {
      const current = reduceResearchRecords(records, loop.loop_id);
      const latest = current.candidates.find((item) => item.candidate_id === candidate.candidate_id);
      if (!latest || latest.status !== "succeeded") throw new Error("candidate is no longer evaluable");
      if (current.operations.some((operation) => operation.candidate_id === candidate.candidate_id
        && operation.kind === "evaluation" && ["reserved", "started"].includes(operation.status))) {
        throw new Error("candidate evaluation is already active");
      }
      await repository.appendUnlocked("candidate.evaluation_reserved", { phase: "evaluation", attempt: 1, idempotency_key: `evaluate:${candidate.candidate_id}` }, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operationId });
    });
    if (evaluator.command.length !== 1 || evaluator.command[0] !== "builtin:result-json") throw new Error("unsupported evaluator command");
    const outputsRoot = candidateOutputsRoot(cwd, candidate);
    const runRoot = resolve(outputsRoot, "..");
    const evaluatorRoot = join(runRoot, "evaluator");
    const evaluationPath = join(evaluatorRoot, "evaluation.json");
    const evaluatorScript = join(evaluatorRoot, "evaluate.mjs");
    await mkdir(evaluatorRoot, { recursive: true });
    await writeFile(evaluatorScript, builtinEvaluatorSource(evaluator.metrics), { encoding: "utf8", mode: 0o500 });
    const job = await this.jobs.submit(cwd, {
      command: [process.execPath, evaluatorScript], execution_cwd: evaluatorRoot, surface: "research-evaluator",
      env: { PI_SCIENCE_OUTPUT_DIR: outputsRoot, PI_SCIENCE_EVALUATION_PATH: evaluationPath },
      requirement: { timeout_seconds: Math.min(loop.budget.max_wall_seconds, 300) },
    });
    await this.publishSubmittedJob(cwd, loop.loop_id, candidate.candidate_id, operationId, job, "succeeded", "candidate.evaluation_started", {
      phase: "evaluation", job_id: job.job_id, evaluation_path: relative(cwd, evaluationPath), evaluator_digest: evaluator.digest,
    }, "candidate.evaluation_failed", { phase: "evaluation", error: "loop finalized before evaluation job publication" });
  }

  private async analyzeCandidate(cwd: string, snapshot: ResearchSnapshot, candidate: ResearchCandidate): Promise<void> {
    const loop = requireLoop(snapshot);
    const operationId = `op-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const repository = this.repository(cwd);
    const payload = { phase: "analysis", attempt: 1, idempotency_key: `analysis:${candidate.candidate_id}` };
    await repository.append("agent.run_reserved", payload, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operationId });
    await repository.append("agent.run_started", payload, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operationId, run_id: operationId });
    try {
      const result = await this.runner.run({ operation_id: operationId, loop, phase: "analysis", context: { cwd, task_type: loop.task_type, objective: loop.objective, candidate, frontier: frontier(snapshot.candidates) } });
      const parsed = researchAgentResultSchema.parse(result.output);
      if (parsed.kind !== "analysis") throw new Error("analysis agent returned a candidate");
      await repository.locked(async (records) => {
        const current = reduceResearchRecords(records, loop.loop_id);
        const status = requireLoop(current).status;
        await repository.appendUnlocked("agent.run_completed", { phase: "analysis", result: parsed, model_tokens: result.model_tokens, cost_usd: result.cost_usd }, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operationId, run_id: result.run_id });
        if (["running", "pausing"].includes(status)) {
          await repository.appendUnlocked("candidate.diagnosed", parsed, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, causation_id: operationId });
        }
      });
    } catch (error) {
      await repository.append("agent.run_failed", { phase: "analysis", error: String(error), ...this.spent(operationId) }, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operationId, run_id: operationId });
      throw error;
    }
  }

  /** Usage a failed agent run already burned, so the budget still accounts for it. */
  private spent(operationId: string): AgentRunUsage {
    const usage = this.runner.usage?.(operationId);
    return { model_tokens: Number(usage?.model_tokens ?? 0), cost_usd: Number(usage?.cost_usd ?? 0) };
  }

  private async cancelActive(cwd: string, loopId: string): Promise<void> {
    const snapshot = await this.repository(cwd).snapshot(loopId);
    await Promise.allSettled(snapshot.operations.filter((operation) => ["reserved", "started"].includes(operation.status)).map(async (operation) => {
      if (operation.kind === "agent" && operation.run_id) await this.runner.cancel(operation.run_id);
      if ((operation.kind === "execution" || operation.kind === "evaluation") && operation.run_id) await this.jobs.cancel(cwd, operation.run_id);
    }));
  }

  private async finishCancellation(cwd: string, snapshot: ResearchSnapshot): Promise<boolean> {
    await this.cancelActive(cwd, snapshot.loop!.loop_id);
    let current = await this.repository(cwd).snapshot(snapshot.loop!.loop_id);
    for (const operation of current.operations.filter((item) => ["reserved", "started"].includes(item.status))) {
      if (operation.kind === "agent") {
        const status = operation.run_id ? await this.runner.status(operation.run_id) : "lost";
        if (status === "running") return false;
        await this.finishOperation(cwd, operation, "agent.run_failed", { phase: operation.phase, status: "cancelled", error: "cancelled by user" });
      } else if (operation.kind === "execution") {
        if (!operation.run_id) {
          await this.finishOperation(cwd, operation, "candidate.execution_failed", { phase: operation.phase, status: "cancelled", error: "cancelled before job start" });
          continue;
        }
        const job = await this.jobs.get(cwd, operation.run_id);
        if (job && !terminalJobs.has(job.status)) return false;
        const candidate = current.candidates.find((item) => item.candidate_id === operation.candidate_id);
        if (job && candidate?.status === "executing") await this.reconcileExecution(cwd, current, candidate);
        else if (!job) await this.finishOperation(cwd, operation, "candidate.execution_failed", { phase: operation.phase, status: "cancelled", error: "job record was not found" });
      } else {
        await this.finishOperation(cwd, operation, "candidate.evaluation_failed", { phase: operation.phase, error: "cancelled by user" });
      }
      current = await this.repository(cwd).snapshot(snapshot.loop!.loop_id);
    }
    current = await this.repository(cwd).snapshot(snapshot.loop!.loop_id);
    const loop = requireLoop(current);
    if (loop.status !== "cancelling") return true;
    if (hasActiveWork(current)) return false;
    const cancelled = nextLoop(loop, { status: "cancelled", stop_reason: "user_cancel", started_at: null });
    await this.repository(cwd).append("loop.state_changed", loopPayload(cancelled, "cancel_completed"), { loop_id: loop.loop_id });
    return true;
  }

  private async recoverInterruptedWork(cwd: string, snapshot: ResearchSnapshot): Promise<boolean> {
    for (const operation of snapshot.operations.filter((item) => ["reserved", "started"].includes(item.status))) {
      if (operation.kind === "agent") {
        const status = operation.run_id ? await this.runner.status(operation.run_id) : "lost";
        if (status === "running") return false;
        await this.finishOperation(cwd, operation, "agent.run_failed", {
          phase: operation.phase,
          status: "lost",
          error: `research agent run is ${status}; retrying the idempotent phase`,
        });
        return true;
      }
      if (operation.kind === "execution") {
        if (!operation.run_id) {
          await this.finishOperation(cwd, operation, "candidate.execution_failed", {
            phase: operation.phase, status: "failed", error: "execution reservation was interrupted before job start",
          });
          return true;
        }
        const job = await this.jobs.get(cwd, operation.run_id);
        if (!job) {
          await this.finishOperation(cwd, operation, "candidate.execution_failed", {
            phase: operation.phase, status: "failed", error: "execution job record was lost",
          });
          return true;
        }
        if (terminalJobs.has(job.status)) {
          const candidate = snapshot.candidates.find((item) => item.candidate_id === operation.candidate_id);
          if (candidate?.status === "executing") await this.reconcileExecution(cwd, snapshot, candidate);
          return true;
        }
        return false;
      }
      if (!operation.run_id) {
        await this.finishOperation(cwd, operation, "candidate.evaluation_failed", {
          phase: operation.phase, error: "evaluation reservation was interrupted before job start",
        });
        return true;
      }
      const job = await this.jobs.get(cwd, operation.run_id);
      if (!job) {
        await this.finishOperation(cwd, operation, "candidate.evaluation_failed", {
          phase: operation.phase, error: "evaluation job record was lost",
        });
        return true;
      }
      if (!terminalJobs.has(job.status)) return false;
      const candidate = snapshot.candidates.find((item) => item.candidate_id === operation.candidate_id);
      if (!candidate) throw new Error("evaluation candidate was not found");
      await this.finalizeEvaluation(cwd, snapshot, candidate, operation, job);
      return true;
    }
    return false;
  }

  private async finalizeEvaluation(
    cwd: string,
    snapshot: ResearchSnapshot,
    candidate: ResearchCandidate,
    operation: ResearchSnapshot["operations"][number],
    job: JobRecord,
  ): Promise<void> {
    const loop = requireLoop(snapshot);
    if (job.status !== "succeeded") {
      const evaluator = loop.evaluator_ref ? findEvaluator(await this.repository(cwd).records(), loop.evaluator_ref.evaluator_id, loop.evaluator_ref.version) : null;
      const evaluation = { metrics: {}, hard_checks: Object.fromEntries((evaluator?.hard_checks ?? []).map((name) => [name, "failed"])), artifact_refs: [], findings: [], model_tokens: 0, cost_usd: 0 };
      await this.repository(cwd).append("candidate.evaluated", {
        phase: "evaluation", evaluation, evaluation_status: "failed",
        evaluator_ref: loop.evaluator_ref, evaluator_job_id: job.job_id,
        error: job.stderr.slice(-4000) || `evaluator job ${job.status}`,
      }, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operation.operation_id, run_id: job.job_id });
      return;
    }
    if (!loop.evaluator_ref) throw new Error("loop evaluator is missing");
    const evaluator = findEvaluator(await this.repository(cwd).records(), loop.evaluator_ref.evaluator_id, loop.evaluator_ref.version);
    if (!evaluator || evaluator.digest !== loop.evaluator_ref.digest) throw new Error("loop evaluator is unavailable or changed");
    const evaluationRelative = String(operation.result?.evaluation_path ?? "");
    const evaluationPath = evaluationRelative ? resolve(cwd, evaluationRelative) : join(resolve(candidateOutputsRoot(cwd, candidate), ".."), "evaluator", "evaluation.json");
    const evaluatorRoot = join(resolve(candidateOutputsRoot(cwd, candidate), ".."), "evaluator");
    if (!within(evaluatorRoot, evaluationPath)) throw new Error("evaluation result escapes evaluator directory");
    const evaluationInfo = await lstat(evaluationPath);
    if (!evaluationInfo.isFile() || evaluationInfo.isSymbolicLink() || evaluationInfo.size > 1_000_000) throw new Error("evaluation result is invalid or too large");
    const raw = JSON.parse(await readFile(evaluationPath, "utf8")) as Record<string, unknown>;
    const rawMetrics = raw.metrics && typeof raw.metrics === "object" ? raw.metrics as Record<string, unknown> : {};
    const metrics = Object.fromEntries(evaluator.metrics.map((metric) => [metric.name, {
      value: Number(rawMetrics[metric.name]), direction: metric.direction, source: metric.source,
    }]));
    const metricsValid = Object.values(metrics).every((metric) => Number.isFinite(metric.value));
    const outputsRoot = candidateOutputsRoot(cwd, candidate);
    const resolvedOutputsRoot = await realpath(outputsRoot);
    const artifacts = [];
    let artifactsValid = true;
    for (const expected of candidate.proposal.expected_artifacts) {
      const fullPath = resolve(outputsRoot, expected.path);
      if (!within(outputsRoot, fullPath)) { artifactsValid = false; continue; }
      try {
        const info = await lstat(fullPath);
        const resolvedArtifact = await realpath(fullPath);
        if (!info.isFile() || info.isSymbolicLink() || !within(resolvedOutputsRoot, resolvedArtifact)) { artifactsValid = false; continue; }
        const sha256 = await hashFile(fullPath);
        artifacts.push({ path: expected.path, kind: expected.kind, sha256 });
      } catch { artifactsValid = false; }
    }
    const hardChecks = Object.fromEntries(evaluator.hard_checks.map((name) => [name,
      name === "artifact_verified" && artifactsValid && artifacts.length > 0 ? "passed" : "failed",
    ]));
    const passed = metricsValid && Object.values(hardChecks).every((status) => status === "passed");
    const evaluation = { metrics: metricsValid ? metrics : {}, hard_checks: hardChecks, artifact_refs: artifacts, findings: [], model_tokens: 0, cost_usd: 0 };
    await this.repository(cwd).append("candidate.evaluated", {
      phase: "evaluation", evaluation, evaluation_status: passed ? "passed" : "failed",
      evaluator_ref: loop.evaluator_ref, evaluator_job_id: job.job_id,
    }, { loop_id: loop.loop_id, candidate_id: candidate.candidate_id, operation_id: operation.operation_id, run_id: job.job_id });
  }

  private async publishSubmittedJob(
    cwd: string,
    loopId: string,
    candidateId: string,
    operationId: string,
    job: JobRecord,
    candidateStatus: ResearchCandidate["status"],
    startedType: string,
    startedPayload: Record<string, unknown>,
    failedType: string,
    failedPayload: Record<string, unknown>,
  ): Promise<void> {
    const repository = this.repository(cwd);
    const published = await repository.locked(async (records) => {
      const current = reduceResearchRecords(records, loopId);
      const operation = current.operations.find((item) => item.operation_id === operationId);
      const candidate = current.candidates.find((item) => item.candidate_id === candidateId);
      if (!operation || operation.status !== "reserved" || candidate?.status !== candidateStatus || !["running", "pausing"].includes(requireLoop(current).status)) return false;
      await repository.appendUnlocked(startedType, startedPayload, { loop_id: loopId, candidate_id: candidateId, operation_id: operationId, run_id: job.job_id });
      return true;
    });
    if (published) return;
    await this.jobs.cancel(cwd, job.job_id);
    await repository.locked(async (records) => {
      const current = reduceResearchRecords(records, loopId);
      const operation = current.operations.find((item) => item.operation_id === operationId);
      if (!operation || operation.status !== "reserved") return;
      await repository.appendUnlocked(failedType, failedPayload, { loop_id: loopId, candidate_id: candidateId, operation_id: operationId, run_id: job.job_id });
    });
  }

  private async finishOperation(
    cwd: string,
    operation: ResearchSnapshot["operations"][number],
    recordType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const repository = this.repository(cwd);
    await repository.locked(async (records) => {
      const current = reduceResearchRecords(records, operation.loop_id);
      const latest = current.operations.find((item) => item.operation_id === operation.operation_id);
      if (!latest || !["reserved", "started"].includes(latest.status)) return;
      await repository.appendUnlocked(recordType, payload, {
        loop_id: operation.loop_id,
        ...(operation.candidate_id ? { candidate_id: operation.candidate_id } : {}),
        operation_id: operation.operation_id,
        ...(operation.run_id ? { run_id: operation.run_id } : {}),
      });
    });
  }

  private async finishPause(cwd: string, loop: ResearchLoop): Promise<void> {
    const paused = nextLoop(loop, { status: "paused", started_at: null });
    await this.repository(cwd).append("loop.state_changed", loopPayload(paused, "pause_completed"), { loop_id: loop.loop_id });
  }

  private async completeLoop(cwd: string, loop: ResearchLoop, reason: string): Promise<void> {
    const completed = nextLoop(loop, { status: "completed", active_wall_ms: activeWallMs(loop), started_at: null, stop_reason: reason });
    await this.repository(cwd).append("loop.state_changed", loopPayload(completed, reason), { loop_id: loop.loop_id });
  }

  private async failLoop(cwd: string, loopId: string, error: unknown): Promise<void> {
    const snapshot = await this.repository(cwd).snapshot(loopId);
    if (!snapshot.loop || terminalLoops.has(snapshot.loop.status) || snapshot.loop.status === "cancelling") return;
    const failed = nextLoop(snapshot.loop, { status: "needs_attention", active_wall_ms: activeWallMs(snapshot.loop), started_at: null, stop_reason: String(error) });
    await this.repository(cwd).append("loop.state_changed", loopPayload(failed, "orchestrator_error"), { loop_id: loopId });
  }
}

function findEvaluator(records: ResearchSnapshot["records"], id: string, version: number): EvaluatorSpec | null {
  const row = [...records].reverse().find((item) => item.record_type === "evaluator.registered" && item.payload.evaluator_id === id && Number(item.payload.version) === version);
  if (!row) return null;
  const parsed = evaluatorSpecSchema.safeParse(row.payload);
  return parsed.success ? parsed.data : null;
}

function evaluatorBlockers(records: ResearchSnapshot["records"], loop: ResearchLoop): string[] {
  const blockers: string[] = [];
  if (!loop.evaluator_ref) blockers.push("an approved deterministic evaluator is required");
  else {
    const evaluator = findEvaluator(records, loop.evaluator_ref.evaluator_id, loop.evaluator_ref.version);
    if (!evaluator) blockers.push("referenced evaluator was not found");
    else {
      if (evaluator.status !== "approved") blockers.push("evaluator must be approved");
      if (evaluator.digest !== loop.evaluator_ref.digest) blockers.push("evaluator digest does not match");
      if (evaluator.metrics.some((metric) => metric.source !== "deterministic")) blockers.push("MVP stop metrics must be deterministic");
      if (evaluator.command.length !== 1 || evaluator.command[0] !== "builtin:result-json") blockers.push("MVP only supports the builtin deterministic result.json evaluator");
    }
  }
  return blockers;
}

function requireLoop(snapshot: ResearchSnapshot): ResearchLoop {
  if (!snapshot.loop) throw new Error("research loop not found");
  return snapshot.loop;
}

function nextLoop(loop: ResearchLoop, changes: Partial<ResearchLoop>): ResearchLoop {
  return researchLoopSchema.parse({ ...loop, ...changes, revision: loop.revision + 1, updated_at: new Date().toISOString() });
}

function loopPayload(loop: ResearchLoop, reason: string): Record<string, unknown> {
  return {
    revision: loop.revision, status: loop.status, updated_at: loop.updated_at,
    started_at: loop.started_at, active_wall_ms: loop.active_wall_ms,
    stop_reason: loop.stop_reason, current_operation_id: loop.current_operation_id, reason,
  };
}

function compactCandidates(candidates: ResearchCandidate[]) {
  return candidates.slice(-10).map((candidate) => ({
    candidate_id: candidate.candidate_id, status: candidate.status,
    approach_summary: candidate.proposal.approach_summary,
    evaluation_status: candidate.evaluation_status,
    metrics: candidate.evaluation?.metrics ?? {},
    stderr_excerpt: candidate.execution.stderr_excerpt ?? "",
  }));
}

function frontier(candidates: ResearchCandidate[]): ResearchCandidate[] {
  const passed = candidates.filter((candidate) => candidate.evaluation_status === "passed" && candidate.evaluation);
  const dominates = (left: ResearchCandidate, right: ResearchCandidate) => {
    const lm = left.evaluation!.metrics; const rm = right.evaluation!.metrics;
    const names = Object.keys(lm);
    if (!names.length || names.some((name) => !rm[name])) return false;
    let better = false;
    for (const name of names) {
      const l = lm[name]!; const r = rm[name]!;
      const noWorse = l.direction === "minimize" ? l.value <= r.value : l.value >= r.value;
      if (!noWorse) return false;
      better ||= l.direction === "minimize" ? l.value < r.value : l.value > r.value;
    }
    return better;
  };
  return passed.filter((candidate) => !passed.some((other) => other !== candidate && dominates(other, candidate)));
}

function hasActiveWork(snapshot: ResearchSnapshot): boolean {
  return snapshot.operations.some((operation) => ["reserved", "started"].includes(operation.status))
    || snapshot.candidates.some((candidate) => candidate.status === "executing");
}

async function makeWritable(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else await chmod(path, 0o644);
}

function delay(ms: number) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

function candidateOutputsRoot(cwd: string, candidate: ResearchCandidate): string {
  const outputsRelative = String(candidate.execution.outputs_dir ?? "");
  const outputsRoot = resolve(cwd, outputsRelative);
  if (!outputsRelative || !within(join(metadataRoot(cwd), "runs"), outputsRoot)) throw new Error("candidate output directory is invalid");
  return outputsRoot;
}

function builtinEvaluatorSource(metrics: EvaluatorSpec["metrics"]): string {
  const specs = JSON.stringify(metrics.map((metric) => ({ name: metric.name })));
  return `import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const outputs = process.env.PI_SCIENCE_OUTPUT_DIR;
const destination = process.env.PI_SCIENCE_EVALUATION_PATH;
if (!outputs || !destination) throw new Error("evaluator environment is incomplete");
const resultPath = join(outputs, "result.json");
const info = await lstat(resultPath);
if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error("result.json is invalid or too large");
const source = JSON.parse(await readFile(resultPath, "utf8"));
const metrics = {};
for (const spec of ${specs}) {
  const value = Number(source[spec.name]);
  if (!Number.isFinite(value)) throw new Error(\`invalid deterministic metric: \${spec.name}\`);
  metrics[spec.name] = value;
}
await writeFile(destination, JSON.stringify({ metrics }) + "\\n", "utf8");
`;
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => digest.update(chunk));
    input.once("error", rejectHash);
    input.once("end", resolveHash);
  });
  return digest.digest("hex");
}
