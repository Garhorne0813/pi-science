import { randomUUID } from "node:crypto";
import { researchAgentResultSchema } from "@pi-science/contracts";
import type { TaskRuntime as AgentRuntime } from "../runtime/agent/runner-transport.js";
import type { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import type { AgentRunRequest, AgentRunResult, AgentRunUsage, ResearchSubagentRunner } from "./types.js";

type ActiveRun = { managerKey: string; process: AgentRuntime; state: "running" | "completed" | "failed"; usage: AgentRunUsage };

export abstract class ResearchTaskRunner implements ResearchSubagentRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    protected readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const runId = request.operation_id || `agent-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const cwd = String(request.context.cwd ?? "");
    if (!cwd) throw new Error("research subagent context is missing cwd");
    const managerKey = `research:${runId}`;
    const process = await this.startProcess(cwd, managerKey, request.loop.loop_id);
    const active: ActiveRun = { managerKey, process, state: "running", usage: { model_tokens: 0, cost_usd: 0 } };
    this.active.set(runId, active);
    let promptIndex = 0;
    const promptAndWait = (message: string) => process.prompt({
      message, clientMessageId: `${managerKey}:${promptIndex++}`, deadline: Date.now() + 10 * 60_000,
      onUsage: (delta) => { active.usage.model_tokens += delta.model_tokens; active.usage.cost_usd += delta.cost_usd; },
    });

    try {
      await process.initialize();
      let response = await promptAndWait(supervisorPrompt(request));
      let output: ReturnType<typeof researchAgentResultSchema.parse> | undefined;
      let parseError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          output = researchAgentResultSchema.parse(parseJsonObject(response));
          break;
        } catch (error) {
          parseError = error;
          if (attempt === 2) break;
          response = await promptAndWait(`Your previous response did not match the required JSON schema. Repair it and return ONLY the corrected JSON object. Do not add markdown or explanation. Validation error: ${String(error).slice(0, 2000)}`);
        }
      }
      if (!output) throw parseError instanceof Error ? parseError : new Error("research supervisor returned invalid JSON");
      active.state = "completed";
      return { run_id: runId, output, model_tokens: active.usage.model_tokens, cost_usd: active.usage.cost_usd };
    } catch (error) {
      active.state = "failed";
      throw error;
    } finally {
      await this.stopProcess(managerKey).catch(() => undefined);
      this.trimRuns();
    }
  }

  async status(runId: string): Promise<"running" | "completed" | "failed" | "lost"> {
    return this.active.get(runId)?.state ?? "lost";
  }

  usage(runId: string): AgentRunUsage | null {
    const run = this.active.get(runId);
    return run ? { ...run.usage } : null;
  }

  async cancel(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run || run.state !== "running") return;
    run.state = "failed";
    await this.stopProcess(run.managerKey);
  }

  protected abstract startProcess(cwd: string, key: string, owner: string): Promise<AgentRuntime>;
  protected abstract stopProcess(key: string): Promise<void>;

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.active.values()].filter((run) => run.state === "running").map((run) => this.stopProcess(run.managerKey)));
  }

  private trimRuns(): void {
    if (this.active.size <= 128) return;
    for (const [runId, run] of this.active) {
      if (run.state !== "running") this.active.delete(runId);
      if (this.active.size <= 128) break;
    }
  }
}

function parseJsonObject(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { /* use bounded extraction */ }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("research supervisor did not return JSON");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function supervisorPrompt(request: AgentRunRequest): string {
  const context = JSON.stringify(request.context, null, 2);
  if (request.phase === "candidate") {
    return `You are the parent research supervisor. Use the installed subagent tool. First ask planner to inspect the supplied research context and propose one conservative next experiment. Respect task_type: optimize tasks must make a measurable change against the supplied deterministic metrics; research_loop tasks may explore a broader hypothesis but must still produce those metrics. Use prior failed candidates as negative evidence and do not repeat them without a specific correction. Then ask a fresh delegate subagent to turn that strategy into a self-contained candidate. Subagents must not edit the workspace or run code. Return ONLY valid JSON matching this shape: {"kind":"candidate","proposal":{"approach_summary":"...","rationale":"...","files":{"solve.sh":"..."},"entrypoint":"solve.sh","parent_candidate_ids":[],"expected_artifacts":[{"path":"result.json","kind":"data"}]}}. The entrypoint must write all outputs beneath the PI_SCIENCE_OUTPUT_DIR environment variable, including result.json values for every required metric. Candidate source must be at most 2 MB. Research context:\n${context}`;
  }
  return `You are the parent research supervisor. Ask a fresh reviewer subagent to analyze the supplied execution and evaluation context. Do not edit files and do not change formal metrics or hard-check results. Return ONLY valid JSON matching: {"kind":"analysis","findings":[{"summary":"..."}],"next_strategy":"..."}. Context:\n${context}`;
}
