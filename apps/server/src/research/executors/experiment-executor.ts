import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CandidateProposal, ResearchNode } from "@pi-science/contracts";
import { metadataRoot } from "../../storage/persistence.js";
import { snapshotCandidate, within } from "../../research-loop/candidate-snapshot.js";
import type { JobCoordinator } from "../../runtime/jobs/job-coordinator.js";
import { findBashExecutable } from "../../support/platform-utils.js";

export interface ExperimentExecutionHandle {
  candidate_id: string;
  job_id: string;
  run_id: string;
  outputs_dir: string;
}

export type ExperimentExecutionState =
  | { status: "running"; handle: ExperimentExecutionHandle }
  | { status: "succeeded"; handle: ExperimentExecutionHandle; result: Record<string, unknown> }
  | { status: "failed"; handle: ExperimentExecutionHandle; error: string };

export interface ResearchExperimentExecutor {
  start(cwd: string, researchId: string, node: Extract<ResearchNode, { kind: "experiment" }>, proposal: CandidateProposal): Promise<ExperimentExecutionHandle>;
  reconcile(cwd: string, node: Extract<ResearchNode, { kind: "experiment" }>, handle: ExperimentExecutionHandle): Promise<ExperimentExecutionState>;
  cancel(cwd: string, handle: ExperimentExecutionHandle): Promise<void>;
}

export class ExperimentExecutor implements ResearchExperimentExecutor {
  constructor(private readonly jobs: JobCoordinator) {}

  async start(cwd: string, researchId: string, node: Extract<ResearchNode, { kind: "experiment" }>, proposal: CandidateProposal): Promise<ExperimentExecutionHandle> {
    const candidate = await snapshotCandidate(cwd, researchId, proposal);
    const source = resolve(cwd, candidate.solution.path);
    const solutionsRoot = join(metadataRoot(cwd), "solutions");
    if (!within(solutionsRoot, source)) throw new Error("candidate source escapes solution root");
    const runId = `run-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const runRoot = join(metadataRoot(cwd), "research-runs", researchId, node.node_id, runId);
    const work = join(runRoot, "work");
    const outputs = join(runRoot, "outputs");
    await mkdir(runRoot, { recursive: true });
    await cp(source, work, { recursive: true, errorOnExist: true });
    await makeWritable(work); await mkdir(outputs, { recursive: true });
    const entrypoint = resolve(work, candidate.solution.entrypoint);
    if (!within(work, entrypoint)) throw new Error("candidate entrypoint escapes work directory");
    const bash = await findBashExecutable();
    if (!bash) throw new Error("Auto Research experiments require bash");
    const job = await this.jobs.submit(cwd, {
      command: entrypointCommand(entrypoint, bash),
      execution_cwd: work,
      surface: "research-graph",
      env: {
        PI_SCIENCE_OUTPUT_DIR: outputs,
        PI_SCIENCE_RUN_ID: runId,
        PI_SCIENCE_CANDIDATE_ID: candidate.candidate_id,
        PI_SCIENCE_RESEARCH_ID: researchId,
        PI_SCIENCE_RESEARCH_NODE_ID: node.node_id,
      },
      requirement: { timeout_seconds: 86_400 },
      research_id: researchId,
      node_id: node.node_id,
    });
    return { candidate_id: candidate.candidate_id, job_id: job.job_id, run_id: runId, outputs_dir: relative(cwd, outputs) };
  }

  async reconcile(cwd: string, node: Extract<ResearchNode, { kind: "experiment" }>, handle: ExperimentExecutionHandle): Promise<ExperimentExecutionState> {
    const job = await this.jobs.get(cwd, handle.job_id);
    if (!job) return { status: "failed", handle, error: "experiment job record was not found" };
    if (["pending", "running"].includes(job.status)) return { status: "running", handle };
    if (job.status !== "succeeded") return { status: "failed", handle, error: job.stderr.slice(-4000) || `experiment job ${job.status}` };
    try {
      const outputs = resolve(cwd, handle.outputs_dir);
      if (!within(join(metadataRoot(cwd), "research-runs"), outputs)) throw new Error("experiment output path is invalid");
      const path = join(outputs, "result.json");
      const info = await stat(path);
      if (!info.isFile() || info.size > 1_000_000) throw new Error("result.json is invalid or too large");
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const metrics: Record<string, number> = {};
      for (const name of node.spec.expected_metrics) {
        const value = Number(raw[name]);
        if (!Number.isFinite(value)) throw new Error(`invalid deterministic metric: ${name}`);
        metrics[name] = value;
      }
      return { status: "succeeded", handle, result: { metrics, raw, outputs_dir: handle.outputs_dir, job_id: job.job_id, candidate_id: handle.candidate_id } };
    } catch (error) {
      return { status: "failed", handle, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async cancel(cwd: string, handle: ExperimentExecutionHandle): Promise<void> { await this.jobs.cancel(cwd, handle.job_id); }
}

/** Choose the interpreter for a candidate entrypoint. Python candidates are
 *  executed with python3 so their script source is not (mis)interpreted by
 *  bash; everything else keeps the legacy bash invocation. */
export function entrypointCommand(entrypointPath: string, bash: string, python = "python3"): string[] {
  return entrypointPath.endsWith(".py") ? [python, entrypointPath] : [bash, entrypointPath];
}

async function makeWritable(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else await chmod(path, 0o644);
}
