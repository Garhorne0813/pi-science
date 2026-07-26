import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { researchLoopSchema } from "@pi-science/contracts";
import { JobCoordinator } from "./job-coordinator.js";
import { snapshotCandidate } from "./research-loop/candidate-snapshot.js";
import { ResearchLoopCoordinator } from "./research-loop/coordinator.js";
import { activeWallMs, stopReason } from "./research-loop/stop-policy.js";
import type { AgentRunRequest, AgentRunResult, ResearchSubagentRunner } from "./research-loop/types.js";

const cleanup: string[] = [];
const coordinators: ResearchLoopCoordinator[] = [];
const jobs: JobCoordinator[] = [];

afterEach(async () => {
  await Promise.allSettled(coordinators.splice(0).map((coordinator) => coordinator.shutdown()));
  await Promise.allSettled(jobs.splice(0).map((coordinator) => coordinator.shutdown()));
  await Promise.all(cleanup.splice(0).map(async (path) => {
    await makeWritable(path).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-research-loop-"));
  cleanup.push(cwd);
  return cwd;
}

function jobCoordinator(): JobCoordinator {
  const coordinator = new JobCoordinator({ environment: async () => ({ ...process.env }) });
  jobs.push(coordinator);
  return coordinator;
}

class FakeRunner implements ResearchSubagentRunner {
  candidateCalls = 0;
  analysisCalls = 0;

  constructor(private readonly scores: (number | null)[] = [0.95]) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (request.phase === "candidate") {
      const score = this.scores[Math.min(this.candidateCalls, this.scores.length - 1)] ?? null;
      this.candidateCalls += 1;
      const write = score === null ? "" : `printf '%s\\n' '{"score":${score}}' > "$PI_SCIENCE_OUTPUT_DIR/result.json"\n`;
      return {
        run_id: request.operation_id,
        model_tokens: 10,
        cost_usd: 0.01,
        output: {
          kind: "candidate",
          proposal: {
            approach_summary: `candidate ${this.candidateCalls}`,
            rationale: "deterministic fixture",
            files: {
              "solve.sh": `#!/usr/bin/env bash\nset -eu\nmkdir -p "$PI_SCIENCE_OUTPUT_DIR"\n${write}`,
            },
            entrypoint: "solve.sh",
            parent_candidate_ids: [],
            expected_artifacts: [{ path: "result.json", kind: "data" }],
          },
        },
      };
    }
    this.analysisCalls += 1;
    return {
      run_id: request.operation_id,
      model_tokens: 5,
      cost_usd: 0.005,
      output: { kind: "analysis", findings: [{ summary: "continue" }], next_strategy: "improve score" },
    };
  }

  async status(): Promise<"lost"> { return "lost"; }
  async cancel(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class BlockingRunner implements ResearchSubagentRunner {
  private runs = new Map<string, { reject: (error: Error) => void; state: "running" | "failed" }>();

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    return new Promise((_, reject) => this.runs.set(request.operation_id, { reject, state: "running" }));
  }

  async status(runId: string): Promise<"running" | "failed" | "lost"> {
    return this.runs.get(runId)?.state ?? "lost";
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.state !== "running") return;
    run.state = "failed";
    run.reject(new Error("cancelled"));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((runId) => this.cancel(runId)));
  }
}

class HookedRunner implements ResearchSubagentRunner {
  private fired = false;

  constructor(private readonly inner: FakeRunner, private readonly beforeFirstCandidate: () => Promise<void>) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (request.phase === "candidate" && !this.fired) {
      this.fired = true;
      await this.beforeFirstCandidate();
    }
    return this.inner.run(request);
  }

  status(): Promise<"lost"> { return this.inner.status(); }
  cancel(): Promise<void> { return this.inner.cancel(); }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
}

class SleepingRunner implements ResearchSubagentRunner {
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return {
      run_id: request.operation_id,
      model_tokens: 1,
      cost_usd: 0,
      output: {
        kind: "candidate",
        proposal: {
          approach_summary: "sleep", rationale: "", files: { "solve.sh": "#!/usr/bin/env bash\nexec sleep 30\n" },
          entrypoint: "solve.sh", parent_candidate_ids: [], expected_artifacts: [],
        },
      },
    };
  }

  async status(): Promise<"lost"> { return "lost"; }
  async cancel(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

async function configuredLoop(coordinator: ResearchLoopCoordinator, cwd: string, input: Record<string, unknown> = {}) {
  const digest = "sha256:research-loop-test-evaluator";
  await coordinator.registerEvaluator(cwd, {
    evaluator_id: "test-evaluator",
    version: 1,
    digest,
    status: "approved",
    metrics: [{ name: "score", direction: "maximize", weight: 1, source: "deterministic" }],
    hard_checks: ["artifact_verified"],
    command: ["builtin:result-json"],
  });
  const loop = await coordinator.create(cwd, {
    title: "Optimize score",
    objective: "Produce a deterministic score",
    evaluator_ref: { evaluator_id: "test-evaluator", version: 1, digest },
    budget: { max_candidates: 4, max_wall_seconds: 60 },
    stop_conditions: { target_metrics: { score: 0.9 }, patience: 3, min_improvement: 0.01 },
    ...input,
  });
  const preflight = await coordinator.preflight(cwd, loop.loop_id);
  expect(preflight.ok).toBe(true);
  return preflight.loop;
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    const value = await read();
    last = value;
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for research loop state: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function makeWritable(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else await chmod(path, 0o644);
}

describe("subagent research loop", () => {
  it("counts only active wall time and includes durable agent usage in budget stops", () => {
    const running = researchLoopSchema.parse({
      loop_id: "loop-budget", revision: 1, title: "Budget", objective: "Budget",
      status: "running", evaluator_ref: null,
      budget: { max_candidates: 10, max_wall_seconds: 60, max_parallel: 1, max_model_tokens: 100 },
      stop_conditions: { target_metrics: {}, patience: 3, min_improvement: 0 }, constraints: [],
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:10.000Z", active_wall_ms: 5_000,
    });
    expect(activeWallMs(running, Date.parse("2026-01-01T00:00:20.000Z"))).toBe(15_000);
    const paused = researchLoopSchema.parse({ ...running, status: "paused", started_at: null });
    expect(activeWallMs(paused, Date.parse("2026-01-02T00:00:00.000Z"))).toBe(5_000);
    expect(stopReason({
      loop: running,
      candidates: [],
      operations: [],
      records: [{
        schema_version: 2, record_id: "record-usage", record_type: "agent.run_completed",
        workspace_id: "/tmp/research", loop_id: running.loop_id, created_at: running.created_at,
        producer: "test", payload: { model_tokens: 100, cost_usd: 0 },
      }],
    }, Date.parse("2026-01-01T00:00:20.000Z"))).toBe("model_token_budget_exhausted");
  });

  it("automatically proposes, executes, evaluates, diagnoses, and stops at a deterministic target", async () => {
    const cwd = await workspace();
    const runner = new FakeRunner([0.4, 0.95]);
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), runner);
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd);

    await coordinator.action(cwd, loop.loop_id, "start");
    const detail = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.status === "completed",
    );

    expect(detail?.stop_reason).toBe("target_metrics_reached");
    expect(detail?.candidates).toHaveLength(2);
    expect(detail?.candidates.at(-1)?.evaluation?.metrics.score?.value).toBe(0.95);
    expect(runner.candidateCalls).toBe(2);
    expect(runner.analysisCalls).toBe(1);
  }, 15_000);

  it("recovers a lost reserved agent operation and retries it without duplicate candidate execution", async () => {
    const cwd = await workspace();
    const runner = new FakeRunner([0.95]);
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), runner);
    coordinators.push(coordinator);
    const ready = await configuredLoop(coordinator, cwd);
    const repository = coordinator.repository(cwd);
    const now = new Date().toISOString();
    await repository.append("loop.state_changed", {
      revision: ready.revision + 1,
      status: "running",
      updated_at: now,
      started_at: now,
      active_wall_ms: ready.active_wall_ms,
      stop_reason: null,
    }, { loop_id: ready.loop_id });
    await repository.append("agent.run_reserved", { phase: "candidate", attempt: 1, idempotency_key: "candidate:1" }, { loop_id: ready.loop_id, operation_id: "op-lost-agent" });
    await repository.append("agent.run_started", { phase: "candidate", attempt: 1, idempotency_key: "candidate:1" }, { loop_id: ready.loop_id, operation_id: "op-lost-agent", run_id: "op-lost-agent" });

    await coordinator.reconcile(cwd);
    const detail = await waitFor(
      () => coordinator.detail(cwd, ready.loop_id),
      (value) => value?.status === "completed",
    );

    expect(detail?.operations.find((operation) => operation.operation_id === "op-lost-agent")?.status).toBe("failed");
    expect(detail?.candidates).toHaveLength(1);
    expect(runner.candidateCalls).toBe(1);
  }, 15_000);

  it("finishes cancellation while a subagent run is in flight", async () => {
    const cwd = await workspace();
    const runner = new BlockingRunner();
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), runner);
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd);

    await coordinator.action(cwd, loop.loop_id, "start");
    await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => Boolean(value?.operations.some((operation) => operation.kind === "agent" && operation.status === "started")),
    );
    await coordinator.action(cwd, loop.loop_id, "cancel");
    const detail = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.status === "cancelled",
    );

    expect(detail?.candidates).toHaveLength(0);
    expect(detail?.operations.every((operation) => !["reserved", "started"].includes(operation.status))).toBe(true);
  });

  it("rejects candidate path escapes and oversized source before writing a snapshot", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi-science"), { recursive: true });

    await expect(snapshotCandidate(cwd, "loop-security", {
      approach_summary: "escape",
      rationale: "",
      files: { "../escape.sh": "exit 0" },
      entrypoint: "../escape.sh",
      parent_candidate_ids: [],
      expected_artifacts: [],
    })).rejects.toThrow(/invalid relative path/);

    await expect(snapshotCandidate(cwd, "loop-security", {
      approach_summary: "large",
      rationale: "",
      files: { "solve.sh": "x".repeat(512_001) },
      entrypoint: "solve.sh",
      parent_candidate_ids: [],
      expected_artifacts: [],
    })).rejects.toThrow(/exceeds 512 KB/);
  });

  it("rejects the reserved solution.json manifest filename in proposals", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi-science"), { recursive: true });

    await expect(snapshotCandidate(cwd, "loop-security", {
      approach_summary: "reserved",
      rationale: "",
      files: { "solve.sh": "exit 0", "./solution.json": "{}" },
      entrypoint: "solve.sh",
      parent_candidate_ids: [],
      expected_artifacts: [],
    })).rejects.toThrow(/reserved/);
  });

  it("records a failed evaluation and moves on when the evaluator job fails", async () => {
    const cwd = await workspace();
    const runner = new FakeRunner([null, 0.95]);
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), runner);
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd);

    await coordinator.action(cwd, loop.loop_id, "start");
    const detail = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.status === "completed" || value?.status === "needs_attention",
      12_000,
    );

    expect(detail?.status).toBe("completed");
    expect(detail?.stop_reason).toBe("target_metrics_reached");
    expect(detail?.candidates).toHaveLength(2);
    expect(detail?.candidates[0]?.status).toBe("evaluated");
    expect(detail?.candidates[0]?.evaluation_status).toBe("failed");
    expect(detail?.candidates[0]?.evaluation?.hard_checks).toEqual({ artifact_verified: "failed" });
    expect(detail?.candidates[1]?.evaluation_status).toBe("passed");
    const operation = detail?.operations.find((item) => item.kind === "evaluation" && item.candidate_id === detail?.candidates[0]?.candidate_id);
    expect(operation?.status).toBe("completed");
    expect(operation?.error).toMatch(/result\.json/);
    const records = await coordinator.repository(cwd).records();
    expect(records.some((row) => row.record_type === "loop.state_changed" && row.payload.status === "needs_attention")).toBe(false);
  }, 20_000);

  it("keeps a proposal generated while pausing and executes it after resume", async () => {
    const cwd = await workspace();
    const inner = new FakeRunner([0.95]);
    let pause = async () => {};
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), new HookedRunner(inner, () => pause()));
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd);
    pause = async () => { await coordinator.action(cwd, loop.loop_id, "pause"); };

    await coordinator.action(cwd, loop.loop_id, "start");
    const paused = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.status === "paused" || value?.status === "needs_attention",
    );
    expect(paused?.status).toBe("paused");
    expect(paused?.candidates).toHaveLength(1);
    expect(paused?.candidates[0]?.status).toBe("proposed");

    await coordinator.action(cwd, loop.loop_id, "resume");
    const detail = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.status === "completed" || value?.status === "needs_attention",
    );
    expect(detail?.status).toBe("completed");
    expect(detail?.candidates).toHaveLength(1);
    expect(inner.candidateCalls).toBe(1);
    const records = await coordinator.repository(cwd).records();
    expect(records.some((row) => row.record_type === "loop.state_changed" && row.payload.status === "needs_attention")).toBe(false);
  }, 15_000);

  it("pauses cleanly instead of needing attention when the candidate agent fails during a pause", async () => {
    const cwd = await workspace();
    const inner = new FakeRunner([0.95]);
    let interrupt = async () => {};
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), new HookedRunner(inner, () => interrupt()));
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd);
    interrupt = async () => {
      await coordinator.action(cwd, loop.loop_id, "pause");
      throw new Error("agent interrupted by pause");
    };

    await coordinator.action(cwd, loop.loop_id, "start");
    const detail = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.status === "paused" || value?.status === "needs_attention",
    );
    expect(detail?.status).toBe("paused");
    expect(detail?.candidates).toHaveLength(0);
    const records = await coordinator.repository(cwd).records();
    expect(records.some((row) => row.record_type === "loop.state_changed" && row.payload.status === "needs_attention")).toBe(false);
  }, 15_000);

  it("rejects starting a second loop while another loop is active in the workspace", async () => {
    const cwd = await workspace();
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), new BlockingRunner());
    coordinators.push(coordinator);
    const first = await configuredLoop(coordinator, cwd);
    await coordinator.action(cwd, first.loop_id, "start");
    await waitFor(
      () => coordinator.detail(cwd, first.loop_id),
      (value) => Boolean(value?.operations.some((operation) => operation.status === "started")),
    );

    const second = await coordinator.create(cwd, {
      title: "Second loop",
      objective: "Second loop",
      evaluator_ref: { evaluator_id: "test-evaluator", version: 1, digest: "sha256:research-loop-test-evaluator" },
    });
    expect((await coordinator.preflight(cwd, second.loop_id)).ok).toBe(true);
    await expect(coordinator.action(cwd, second.loop_id, "start")).rejects.toThrow(/already/);

    await coordinator.action(cwd, first.loop_id, "cancel");
    await waitFor(() => coordinator.detail(cwd, first.loop_id), (value) => value?.status === "cancelled");
    const started = await coordinator.action(cwd, second.loop_id, "start");
    expect(started.status).toBe("running");
    await coordinator.action(cwd, second.loop_id, "cancel");
    await waitFor(() => coordinator.detail(cwd, second.loop_id), (value) => value?.status === "cancelled");
  }, 15_000);

  it("cancels the active execution job when the user completes a running loop", async () => {
    const cwd = await workspace();
    const executionJobs = jobCoordinator();
    const coordinator = new ResearchLoopCoordinator(executionJobs, new SleepingRunner());
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd);
    await coordinator.action(cwd, loop.loop_id, "start");
    const executing = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.candidates[0]?.status === "executing",
    );
    const jobId = String(executing?.candidates[0]?.execution.job_id ?? "");

    const completed = await coordinator.action(cwd, loop.loop_id, "complete");
    expect(completed.status).toBe("completed");
    const job = await waitFor(
      () => executionJobs.get(cwd, jobId),
      (value) => Boolean(value && ["succeeded", "failed", "cancelled", "timed_out"].includes(value.status)),
    );
    expect(job?.status).toBe("cancelled");
  }, 15_000);

  it("stops with patience_exhausted when deterministic scores plateau", async () => {
    const cwd = await workspace();
    const runner = new FakeRunner([0.5]);
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), runner);
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd, {
      budget: { max_candidates: 6, max_wall_seconds: 60 },
      stop_conditions: { target_metrics: {}, patience: 2, min_improvement: 0 },
    });

    await coordinator.action(cwd, loop.loop_id, "start");
    const detail = await waitFor(
      () => coordinator.detail(cwd, loop.loop_id),
      (value) => value?.status === "completed" || value?.status === "needs_attention",
      15_000,
    );

    expect(detail?.status).toBe("completed");
    expect(detail?.stop_reason).toBe("patience_exhausted");
    expect(detail?.candidates).toHaveLength(3);
  }, 20_000);

  it("re-validates the evaluator when starting a ready loop", async () => {
    const cwd = await workspace();
    const coordinator = new ResearchLoopCoordinator(jobCoordinator(), new FakeRunner());
    coordinators.push(coordinator);
    const loop = await configuredLoop(coordinator, cwd);
    await coordinator.repository(cwd).append("evaluator.registered", {
      evaluator_id: "test-evaluator", version: 1, digest: "sha256:tampered-digest",
      status: "approved",
      metrics: [{ name: "score", direction: "maximize", weight: 1, source: "deterministic" }],
      hard_checks: ["artifact_verified"], command: ["builtin:result-json"],
      created_at: new Date().toISOString(),
    }, { producer: "test" });

    await expect(coordinator.action(cwd, loop.loop_id, "start")).rejects.toThrow(/digest does not match/);
    expect((await coordinator.detail(cwd, loop.loop_id))?.status).toBe("ready");
  });
});
