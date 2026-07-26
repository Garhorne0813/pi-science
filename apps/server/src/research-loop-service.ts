import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  candidateEvaluationSchema,
  candidateProposalSchema,
  createResearchLoopSchema,
  evaluatorSpecSchema,
  researchLoopSchema,
  type CandidateEvaluation,
  type CandidateProposal,
  type EvaluatorSpec,
  type ResearchLoop,
} from "@pi-science/contracts";
import { appendJsonLine, metadataRoot, readJsonLines, withFileWriteLock, writeJsonAtomic } from "./persistence.js";
import type { JobCoordinator, JobRecord } from "./job-coordinator.js";

export interface ResearchRecord {
  schema_version: 1;
  record_id: string;
  record_type: string;
  workspace_id: string;
  loop_id?: string;
  candidate_id?: string;
  run_id?: string;
  session_id?: string;
  created_at: string;
  producer: string;
  causation_id?: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface ExperienceRecord {
  experience_id: string;
  loop_id: string;
  candidate_id: string;
  status: string;
  approach_summary: string;
  solution: Record<string, unknown>;
  execution: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  evaluation: Record<string, unknown>;
  parent_candidate_ids: string[];
  inspiration_id?: string | null;
  created_at: string;
}

const terminalJobStates = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const terminalLoopStates = new Set(["completed", "failed", "cancelled"]);

function timestamp(): string { return new Date().toISOString(); }
function id(prefix: string): string { return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`; }

function safeRelativePath(value: string): string {
  const normalized = normalize(value.replaceAll("\\", "/"));
  if (!value || isAbsolute(value) || normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid relative path: ${value}`);
  }
  return normalized;
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function makeWritable(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else {
    await chmod(path, 0o644);
  }
}

export class ResearchLoopService {
  constructor(private readonly cwd: string, private readonly jobs: JobCoordinator) {}

  private recordsPath(): string { return join(metadataRoot(this.cwd), "research-records.jsonl"); }
  private mutationLock(): string { return join(metadataRoot(this.cwd), ".research-mutation-lock"); }
  private solutionsRoot(): string { return join(metadataRoot(this.cwd), "solutions"); }
  private runsRoot(): string { return join(metadataRoot(this.cwd), "runs"); }

  async records(): Promise<ResearchRecord[]> { return readJsonLines<ResearchRecord>(this.recordsPath()); }

  async append(recordType: string, payload: Record<string, unknown>, extra: Partial<ResearchRecord> = {}): Promise<ResearchRecord> {
    const row: ResearchRecord = {
      schema_version: 1,
      record_id: id("record"),
      record_type: recordType,
      workspace_id: this.cwd,
      created_at: timestamp(),
      producer: "node-control-plane",
      correlation_id: extra.loop_id,
      payload,
      ...extra,
    };
    await appendJsonLine(this.recordsPath(), row);
    return row;
  }

  async listLoops(): Promise<ResearchLoop[]> {
    const result = new Map<string, Record<string, unknown>>();
    for (const row of await this.records()) {
      if (!row.loop_id) continue;
      if (row.record_type === "loop.created") result.set(row.loop_id, { ...row.payload, loop_id: row.loop_id });
      else if (result.has(row.loop_id) && ["loop.updated", "loop.state_changed"].includes(row.record_type)) {
        result.set(row.loop_id, { ...result.get(row.loop_id), ...row.payload });
      }
    }
    return [...result.values()].flatMap((value) => {
      const parsed = researchLoopSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getLoop(loopId: string): Promise<ResearchLoop | null> {
    return (await this.listLoops()).find((loop) => loop.loop_id === loopId) ?? null;
  }

  async createLoop(input: unknown): Promise<ResearchLoop> {
    const parsed = createResearchLoopSchema.parse(input);
    const now = timestamp();
    const loop = researchLoopSchema.parse({
      schema_version: 1,
      loop_id: id("loop"),
      title: parsed.title,
      objective: parsed.objective,
      status: "draft",
      mode: parsed.mode,
      evaluator_ref: parsed.evaluator_ref ?? null,
      budget: {
        max_candidates: 20,
        max_wall_seconds: 7200,
        max_parallel: 1,
        ...parsed.budget,
      },
      stop_conditions: { target_metrics: {}, patience: 5, min_improvement: 0, ...parsed.stop_conditions },
      constraints: parsed.constraints,
      created_by: parsed.created_by,
      created_at: now,
      updated_at: now,
      stop_reason: null,
    });
    await this.append("loop.created", loop, { loop_id: loop.loop_id, producer: parsed.created_by });
    return loop;
  }

  async updateLoop(loopId: string, input: unknown): Promise<ResearchLoop> {
    const loop = await this.requireLoop(loopId);
    if (!["draft", "configuring", "paused"].includes(loop.status)) throw new Error("only draft, configuring, or paused loops can be edited");
    const changes = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const candidate = researchLoopSchema.parse({ ...loop, ...changes, loop_id: loop.loop_id, status: loop.status, updated_at: timestamp() });
    const payload = { ...candidate } as Record<string, unknown>;
    delete payload.loop_id;
    await this.append("loop.updated", payload, { loop_id: loopId, causation_id: loop.updated_at });
    return candidate;
  }

  async evaluator(evaluatorId: string, version: number): Promise<EvaluatorSpec | null> {
    const rows = await this.records();
    const row = [...rows].reverse().find((item) => item.record_type === "evaluator.registered"
      && item.payload.evaluator_id === evaluatorId && Number(item.payload.version) === version);
    if (!row) return null;
    const parsed = evaluatorSpecSchema.safeParse(row.payload);
    return parsed.success ? parsed.data : null;
  }

  async registerEvaluator(input: unknown): Promise<{ record_id: string; evaluator: EvaluatorSpec }> {
    const evaluator = evaluatorSpecSchema.parse({ ...(input as object), created_at: timestamp() });
    if (await this.evaluator(evaluator.evaluator_id, evaluator.version)) throw new Error("evaluator version already exists");
    const row = await this.append("evaluator.registered", evaluator, { producer: "user" });
    return { record_id: row.record_id, evaluator };
  }

  async preflight(loopId: string): Promise<{ ok: boolean; blockers: string[]; loop: ResearchLoop }> {
    const loop = await this.requireLoop(loopId);
    if (!["draft", "configuring", "ready"].includes(loop.status)) throw new Error(`cannot preflight a ${loop.status} loop`);
    const blockers: string[] = [];
    if (!loop.evaluator_ref) blockers.push("an approved evaluator is required");
    else {
      const evaluator = await this.evaluator(loop.evaluator_ref.evaluator_id, loop.evaluator_ref.version);
      if (!evaluator) blockers.push("referenced evaluator was not found");
      else {
        if (evaluator.status !== "approved") blockers.push("evaluator must be approved");
        if (evaluator.digest !== loop.evaluator_ref.digest) blockers.push("evaluator digest does not match");
        if (!evaluator.metrics.length) blockers.push("evaluator must declare at least one metric");
      }
    }
    if (loop.mode !== "serial" || loop.budget.max_parallel !== 1) blockers.push("MVP supports serial loops with max_parallel=1 only");
    if (blockers.length) return { ok: false, blockers, loop };
    const ready = loop.status === "ready" ? loop : await this.changeState(loop, "ready", "preflight_passed");
    return { ok: true, blockers: [], loop: ready };
  }

  async action(loopId: string, action: string): Promise<ResearchLoop> {
    const loop = await this.requireLoop(loopId);
    const targets: Record<string, ResearchLoop["status"]> = {
      start: "running", pause: "paused", resume: "running", cancel: "cancelled", complete: "completed",
    };
    const target = targets[action];
    if (!target) throw new Error("unknown research loop action");
    const allowed: Record<ResearchLoop["status"], ResearchLoop["status"][]> = {
      draft: ["cancelled"], configuring: ["cancelled"], ready: ["running", "cancelled"],
      running: ["paused", "completed", "failed", "cancelled"], paused: ["running", "cancelled"],
      completed: [], failed: [], cancelled: [],
    };
    if (!allowed[loop.status].includes(target)) throw new Error(`invalid loop transition: ${loop.status} -> ${target}`);
    if (action === "cancel") await this.cancelActiveJobs(loopId);
    return this.changeState(loop, target, `user_${action}`);
  }

  async propose(loopId: string, input: unknown): Promise<Record<string, unknown>> {
    const proposal = candidateProposalSchema.parse(input);
    return withFileWriteLock(this.mutationLock(), async () => {
      const loop = await this.requireLoop(loopId);
      if (loop.status !== "running") throw new Error("research loop must be running");
      const rows = (await this.records()).filter((row) => row.loop_id === loopId);
      const proposed = rows.filter((row) => row.record_type === "candidate.proposed");
      if (proposal.idempotency_key) {
        const previous = proposed.find((row) => row.payload.idempotency_key === proposal.idempotency_key);
        if (previous) return { candidate_id: previous.candidate_id, loop_id: loopId, ...previous.payload };
      }
      const exhaustion = this.budgetExhaustion(loop, rows);
      if (exhaustion) throw new Error(exhaustion);
      if (loop.mode === "serial") {
        const finished = new Set(rows.filter((row) => row.record_type === "candidate.execution_finished").map((row) => row.candidate_id));
        const active = rows.find((row) => row.record_type === "candidate.execution_started" && !finished.has(row.candidate_id));
        if (active) throw new Error("serial loop already has an active candidate");
      }
      const manifest = await this.snapshotCandidate(loop, proposal);
      await this.append("candidate.proposed", manifest, {
        loop_id: loopId,
        candidate_id: String(manifest.candidate_id),
        producer: "candidate-service",
        causation_id: proposal.inspiration_id ?? undefined,
      });
      return manifest;
    });
  }

  async execute(loopId: string, candidateId: string): Promise<JobRecord> {
    const loop = await this.requireLoop(loopId);
    if (loop.status !== "running") throw new Error("research loop must be running");
    const rows = (await this.records()).filter((row) => row.loop_id === loopId && row.candidate_id === candidateId);
    const proposal = rows.find((row) => row.record_type === "candidate.proposed");
    if (!proposal) throw new Error("candidate not found in this loop");
    if (rows.some((row) => row.record_type === "candidate.execution_started")) throw new Error("candidate has already been executed");
    const source = resolve(this.cwd, String((proposal.payload.solution as Record<string, unknown>)?.path ?? ""));
    if (!within(this.solutionsRoot(), source)) throw new Error("candidate source escapes solution root");
    const runId = id("run");
    const runRoot = join(this.runsRoot(), runId);
    const work = join(runRoot, "work");
    const outputs = join(runRoot, "outputs");
    await mkdir(runRoot, { recursive: true });
    await cp(source, work, { recursive: true, errorOnExist: true });
    await makeWritable(work);
    await mkdir(outputs, { recursive: true });
    const entrypoint = safeRelativePath(String((proposal.payload.solution as Record<string, unknown>)?.entrypoint ?? "solve.sh"));
    const script = join(work, entrypoint);
    if (!within(work, script)) throw new Error("candidate entrypoint escapes work directory");
    const job = await this.jobs.submit(this.cwd, {
      command: ["bash", script],
      surface: "research-loop",
      execution_cwd: work,
      env: { PI_SCIENCE_OUTPUT_DIR: outputs, PI_SCIENCE_RUN_ID: runId, PI_SCIENCE_CANDIDATE_ID: candidateId },
      requirement: { timeout_seconds: Math.min(loop.budget.max_wall_seconds, 86_400) },
    });
    await this.append("candidate.execution_started", { job_id: job.job_id, run_id: runId, work_dir: relative(this.cwd, work), outputs_dir: relative(this.cwd, outputs) }, {
      loop_id: loopId, candidate_id: candidateId, run_id: job.job_id, producer: "research-loop-service", causation_id: proposal.record_id,
    });
    void this.observeExecution(loopId, candidateId, job.job_id, runId);
    return job;
  }

  async evaluate(loopId: string, candidateId: string, input: unknown): Promise<ExperienceRecord> {
    const loop = await this.requireLoop(loopId);
    const evaluation = candidateEvaluationSchema.parse(input);
    const evaluator = loop.evaluator_ref ? await this.evaluator(loop.evaluator_ref.evaluator_id, loop.evaluator_ref.version) : null;
    if (!evaluator) throw new Error("loop evaluator is missing");
    const experiences = await this.experiences(loopId);
    const experience = experiences.find((item) => item.candidate_id === candidateId);
    if (!experience) throw new Error("candidate not found in this loop");
    if (experience.status !== "succeeded") throw new Error("candidate execution must succeed before evaluation");
    if (experience.evaluation && Object.keys(experience.evaluation).length) throw new Error("candidate has already been evaluated");
    const declared = new Map(evaluator.metrics.map((metric) => [metric.name, metric]));
    for (const metric of evaluator.metrics) {
      const value = evaluation.metrics[metric.name];
      if (!value) throw new Error(`evaluation is missing metric: ${metric.name}`);
      if (value.direction !== metric.direction) throw new Error(`metric direction mismatch: ${metric.name}`);
    }
    for (const name of Object.keys(evaluation.metrics)) if (!declared.has(name)) throw new Error(`evaluation contains undeclared metric: ${name}`);
    for (const check of evaluator.hard_checks) if (!evaluation.hard_checks[check]) throw new Error(`evaluation is missing hard check: ${check}`);
    const outputsRelative = typeof experience.execution.outputs_dir === "string" ? experience.execution.outputs_dir : "";
    const outputsRoot = resolve(this.cwd, outputsRelative);
    if (!outputsRelative || !within(this.runsRoot(), outputsRoot)) throw new Error("candidate output directory is invalid");
    if (evaluator.hard_checks.includes("artifact_verified") && evaluation.hard_checks.artifact_verified === "passed" && evaluation.artifact_refs.length === 0) {
      throw new Error("artifact_verified requires at least one artifact reference");
    }
    for (const artifact of evaluation.artifact_refs) {
      const artifactPath = safeRelativePath(String(artifact.path ?? ""));
      const fullPath = resolve(outputsRoot, artifactPath);
      if (!within(outputsRoot, fullPath)) throw new Error(`artifact path escapes output directory: ${artifactPath}`);
      try { if (!(await stat(fullPath)).isFile()) throw new Error("not a file"); }
      catch { throw new Error(`declared artifact was not found: ${artifactPath}`); }
    }
    const evaluationStatus = evaluator.hard_checks.some((check) => evaluation.hard_checks[check] !== "passed") ? "failed" : "passed";
    await this.append("candidate.evaluated", { ...evaluation, evaluation_status: evaluationStatus, evaluator_ref: loop.evaluator_ref }, {
      loop_id: loopId, candidate_id: candidateId, producer: "evaluator-service",
    });
    const updated = (await this.experiences(loopId)).find((item) => item.candidate_id === candidateId)!;
    const reason = await this.stopReason(loop);
    if (reason && !terminalLoopStates.has((await this.requireLoop(loopId)).status)) await this.changeState(await this.requireLoop(loopId), "completed", reason);
    return updated;
  }

  async experiences(loopId?: string): Promise<ExperienceRecord[]> {
    const rows = (await this.records()).filter((row) => !loopId || row.loop_id === loopId);
    const candidates = new Map<string, ResearchRecord[]>();
    for (const row of rows) {
      if (!row.candidate_id || !row.loop_id || !row.record_type.startsWith("candidate.")) continue;
      const key = `${row.loop_id}\0${row.candidate_id}`;
      candidates.set(key, [...(candidates.get(key) ?? []), row]);
    }
    const result: ExperienceRecord[] = [];
    for (const lifecycle of candidates.values()) {
      const proposed = lifecycle.find((row) => row.record_type === "candidate.proposed");
      if (!proposed?.candidate_id || !proposed.loop_id) continue;
      const started = lifecycle.find((row) => row.record_type === "candidate.execution_started");
      const finished = lifecycle.find((row) => row.record_type === "candidate.execution_finished");
      const evaluated = lifecycle.find((row) => row.record_type === "candidate.evaluated");
      const evaluation = evaluated ? {
        metrics: evaluated.payload.metrics ?? {}, hard_checks: evaluated.payload.hard_checks ?? {},
        findings: evaluated.payload.findings ?? [], status: evaluated.payload.evaluation_status ?? "failed",
      } : {};
      result.push({
        experience_id: `exp-${proposed.candidate_id}`,
        loop_id: proposed.loop_id,
        candidate_id: proposed.candidate_id,
        status: evaluated ? String(evaluated.payload.evaluation_status ?? "evaluated") : finished ? String(finished.payload.status ?? "finished") : started ? "running" : "proposed",
        approach_summary: String(evaluated?.payload.approach_summary || proposed.payload.approach_summary || ""),
        solution: (proposed.payload.solution ?? {}) as Record<string, unknown>,
        execution: { ...(started?.payload ?? {}), ...(finished?.payload ?? {}) },
        artifacts: (evaluated?.payload.artifact_refs ?? []) as Array<Record<string, unknown>>,
        evaluation,
        parent_candidate_ids: Array.isArray(proposed.payload.parent_candidate_ids) ? proposed.payload.parent_candidate_ids.map(String) : [],
        inspiration_id: typeof proposed.payload.inspiration_id === "string" ? proposed.payload.inspiration_id : null,
        created_at: proposed.created_at,
      });
    }
    return result.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async frontier(loopId: string): Promise<ExperienceRecord[]> {
    const candidates = (await this.experiences(loopId)).filter((item) => item.evaluation.status === "passed" && Object.keys((item.evaluation.metrics ?? {}) as object).length > 0);
    const dominates = (left: ExperienceRecord, right: ExperienceRecord): boolean => {
      const lm = left.evaluation.metrics as Record<string, { value: number; direction: "maximize" | "minimize" }>;
      const rm = right.evaluation.metrics as Record<string, { value: number; direction: "maximize" | "minimize" }>;
      const names = Object.keys(lm);
      if (!names.length || names.length !== Object.keys(rm).length || names.some((name) => !rm[name])) return false;
      let better = false;
      for (const name of names) {
        const l = lm[name]!; const r = rm[name]!;
        const noWorse = l.direction === "minimize" ? l.value <= r.value : l.value >= r.value;
        const strict = l.direction === "minimize" ? l.value < r.value : l.value > r.value;
        if (!noWorse) return false;
        better ||= strict;
      }
      return better;
    };
    return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && dominates(other, candidate)));
  }

  researchIntent(input: unknown): Record<string, unknown> {
    const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const objective = String(body.objective ?? body.message ?? "").trim();
    if (!objective) throw new Error("research objective is required");
    const title = objective.length > 80 ? `${objective.slice(0, 77)}...` : objective;
    return {
      draft: {
        title,
        objective,
        mode: "serial",
        budget: { max_candidates: 10, max_wall_seconds: 7200, max_parallel: 1 },
        stop_conditions: { target_metrics: {}, patience: 5, min_improvement: 0 },
      },
      missing_fields: ["evaluator_ref"],
      requires_confirmation: true,
    };
  }

  private async snapshotCandidate(loop: ResearchLoop, proposal: CandidateProposal): Promise<Record<string, unknown>> {
    const candidateId = id("candidate");
    const root = this.solutionsRoot();
    const destination = join(root, candidateId);
    const temporary = join(root, `.${candidateId}.${process.pid}.tmp`);
    const entrypoint = safeRelativePath(proposal.entrypoint);
    const normalized = new Map<string, string>();
    let total = 0;
    for (const [raw, content] of Object.entries(proposal.files)) {
      const path = safeRelativePath(raw);
      if (normalized.has(path)) throw new Error(`duplicate candidate path: ${path}`);
      total += Buffer.byteLength(content, "utf8");
      if (total > 2_000_000) throw new Error("candidate source exceeds 2 MB");
      normalized.set(path, content);
    }
    if (!normalized.has(entrypoint)) throw new Error("entrypoint must be included in candidate files");
    const digest = createHash("sha256");
    for (const path of [...normalized.keys()].sort()) { digest.update(path); digest.update("\0"); digest.update(normalized.get(path)!); digest.update("\0"); }
    const solutionDigest = `sha256:${digest.digest("hex")}`;
    await mkdir(temporary, { recursive: true });
    for (const [path, content] of normalized) {
      const target = join(temporary, path);
      if (!within(temporary, target)) throw new Error(`candidate path escapes snapshot: ${path}`);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", mode: path === entrypoint ? 0o700 : 0o600 });
    }
    const manifest = {
      candidate_id: candidateId,
      loop_id: loop.loop_id,
      approach_summary: proposal.approach_summary,
      solution: { path: relative(this.cwd, destination), entrypoint, digest: solutionDigest },
      parent_candidate_ids: proposal.parent_candidate_ids,
      inspiration_id: proposal.inspiration_id ?? null,
      idempotency_key: proposal.idempotency_key ?? null,
    };
    await writeJsonAtomic(join(temporary, "solution.json"), manifest);
    await rename(temporary, destination);
    await this.makeReadOnly(destination, entrypoint);
    return manifest;
  }

  private async makeReadOnly(path: string, entrypoint: string, root = path): Promise<void> {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await this.makeReadOnly(join(path, name), entrypoint, root);
      await chmod(path, 0o555);
    } else {
      await chmod(path, relative(root, path) === entrypoint ? 0o555 : 0o444);
    }
  }

  private async observeExecution(loopId: string, candidateId: string, jobId: string, runId: string): Promise<void> {
    try {
      for (;;) {
        const job = await this.jobs.get(this.cwd, jobId);
        if (!job) return;
        if (terminalJobStates.has(job.status)) {
          await this.append("candidate.execution_finished", {
            job_id: jobId, run_id: runId, status: job.status, return_code: job.return_code ?? null,
            started_at: job.started_at ?? null, finished_at: job.ended_at ?? null,
            stdout_excerpt: job.stdout.slice(-4000), stderr_excerpt: job.stderr.slice(-4000),
          }, { loop_id: loopId, candidate_id: candidateId, run_id: jobId, producer: "research-loop-service" });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      await this.append("candidate.execution_finished", { job_id: jobId, run_id: runId, status: "failed", error: String(error) }, {
        loop_id: loopId, candidate_id: candidateId, run_id: jobId, producer: "research-loop-service",
      });
    }
  }

  private async cancelActiveJobs(loopId: string): Promise<void> {
    const rows = (await this.records()).filter((row) => row.loop_id === loopId);
    const finished = new Set(rows.filter((row) => row.record_type === "candidate.execution_finished").map((row) => row.run_id));
    for (const row of rows.filter((item) => item.record_type === "candidate.execution_started" && item.run_id && !finished.has(item.run_id))) {
      await this.jobs.cancel(this.cwd, row.run_id!);
    }
  }

  private budgetExhaustion(loop: ResearchLoop, rows: ResearchRecord[]): string | null {
    const candidates = new Set(rows.filter((row) => row.record_type === "candidate.proposed" && row.candidate_id).map((row) => row.candidate_id));
    if (candidates.size >= loop.budget.max_candidates) return "candidate_budget_exhausted";
    if ((Date.now() - Date.parse(loop.created_at)) / 1000 >= loop.budget.max_wall_seconds) return "wall_time_budget_exhausted";
    const evaluations = rows.filter((row) => row.record_type === "candidate.evaluated");
    const tokens = evaluations.reduce((sum, row) => sum + Number(row.payload.model_tokens ?? 0), 0);
    const cost = evaluations.reduce((sum, row) => sum + Number(row.payload.cost_usd ?? 0), 0);
    if (loop.budget.max_model_tokens != null && tokens >= loop.budget.max_model_tokens) return "model_token_budget_exhausted";
    if (loop.budget.max_cost_usd != null && cost >= loop.budget.max_cost_usd) return "cost_budget_exhausted";
    return null;
  }

  private async stopReason(loop: ResearchLoop): Promise<string | null> {
    const rows = (await this.records()).filter((row) => row.loop_id === loop.loop_id);
    const exhaustion = this.budgetExhaustion(loop, rows);
    if (exhaustion) return exhaustion;
    const passed = rows.filter((row) => row.record_type === "candidate.evaluated" && row.payload.evaluation_status === "passed");
    if (!passed.length) return null;
    const targets = loop.stop_conditions.target_metrics;
    if (Object.keys(targets).length) {
      const metrics = passed.at(-1)!.payload.metrics as Record<string, { value?: unknown; direction?: unknown }>;
      const reached = Object.entries(targets).every(([name, target]) => {
        const metric = metrics[name];
        if (!metric || !Number.isFinite(Number(metric.value))) return false;
        return metric.direction === "minimize" ? Number(metric.value) <= target : Number(metric.value) >= target;
      });
      if (reached) return "target_metrics_reached";
    }
    return null;
  }

  private async changeState(loop: ResearchLoop, status: ResearchLoop["status"], reason: string): Promise<ResearchLoop> {
    const updated = researchLoopSchema.parse({
      ...loop, status, updated_at: timestamp(), stop_reason: terminalLoopStates.has(status) ? reason : null,
    });
    await this.append("loop.state_changed", { status: updated.status, updated_at: updated.updated_at, stop_reason: updated.stop_reason, reason }, {
      loop_id: loop.loop_id, producer: "research-loop-service", causation_id: loop.updated_at,
    });
    return updated;
  }

  private async requireLoop(loopId: string): Promise<ResearchLoop> {
    const loop = await this.getLoop(loopId);
    if (!loop) throw new Error("research loop not found");
    return loop;
  }
}
