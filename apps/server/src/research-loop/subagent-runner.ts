import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { researchAgentResultSchema } from "@pi-science/contracts";
import { metadataRoot } from "../storage/persistence.js";
import { PiManager, piManager } from "../runtime/pi/pi-manager.js";
import type { PiProcess, PiEvent } from "../runtime/pi/pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../runtime/pi/pi-runtime-launch.js";
import type { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import type { AgentRunRequest, AgentRunResult, AgentRunUsage, ResearchSubagentRunner } from "./types.js";

type ActiveRun = { managerKey: string; process: PiProcess; state: "running" | "completed" | "failed"; usage: AgentRunUsage };

export class PiResearchSubagentRunner implements ResearchSubagentRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
    private readonly manager: PiManager = piManager,
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const runId = request.operation_id || `agent-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const cwd = String(request.context.cwd ?? "");
    if (!cwd) throw new Error("research subagent context is missing cwd");
    const sessionDir = join(metadataRoot(cwd), "research-sessions", request.loop.loop_id);
    await mkdir(sessionDir, { recursive: true });
    const options = buildPiProcessOptions(cwd, loadDefaultPiConfig(), undefined, await this.environments.environment(cwd));
    if (!options) throw new Error("Pi CLI is not configured");
    const index = options.args.indexOf("--session-dir");
    if (index >= 0) options.args[index + 1] = sessionDir;
    if (options.web) options.web.runtime.sessionDir = sessionDir;
    options.requestTimeoutMs = 30_000;

    const managerKey = `research:${runId}`;
    const process = await this.manager.start(managerKey, options);
    const active: ActiveRun = { managerKey, process, state: "running", usage: { model_tokens: 0, cost_usd: 0 } };
    this.active.set(runId, active);
    let text = "";
    let settle: (() => void) | null = null;
    let rejectCycle: ((error: Error) => void) | null = null;
    process.on("event", (event: PiEvent) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
        const type = String(update?.type ?? "");
        if (["text_delta", "text"].includes(type)) {
          text += String(update?.delta ?? update?.text ?? update?.content ?? "");
          if (Buffer.byteLength(text, "utf8") > 2_000_000) rejectCycle?.(new Error("research supervisor response exceeds 2 MB"));
        }
      }
      if (event.type === "message_end") {
        const message = event.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        // Accumulated on the run itself so a failure still reports what it spent.
        active.usage.model_tokens += Number(usage?.input ?? 0) + Number(usage?.output ?? 0);
        active.usage.cost_usd += Number((usage?.cost as Record<string, unknown> | undefined)?.total ?? 0);
      }
      if (event.type === "agent_settled") settle?.();
    });
    process.once("exit", () => rejectCycle?.(new Error("research supervisor exited before completing")));

    const promptAndWait = async (message: string): Promise<string> => {
      text = "";
      const completed = new Promise<void>((resolvePrompt, rejectPrompt) => {
        const timeout = setTimeout(() => rejectPrompt(new Error("research supervisor timed out")), 10 * 60_000);
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          settle = null;
          rejectCycle = null;
          error ? rejectPrompt(error) : resolvePrompt();
        };
        settle = () => finish();
        rejectCycle = (error) => finish(error);
      });
      const acknowledged = await process.sendCommand("prompt", { message });
      if (!acknowledged.success) {
        rejectCycle?.(new Error(String(acknowledged.error ?? "research supervisor rejected prompt")));
      }
      await completed;
      return text;
    };

    try {
      const state = await process.sendCommand("get_state");
      if (!state.success) throw new Error(String(state.error ?? "unable to initialize research supervisor"));
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
      process.removeAllListeners("event");
      process.removeAllListeners("exit");
      await this.manager.stop(managerKey).catch(() => undefined);
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
    await this.manager.stop(run.managerKey);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.active.values()].filter((run) => run.state === "running").map((run) => this.manager.stop(run.managerKey)));
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
