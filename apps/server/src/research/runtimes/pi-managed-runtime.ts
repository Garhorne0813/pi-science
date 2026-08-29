import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { metadataRoot } from "../../storage/persistence.js";
import { PiManager } from "../../runtime/pi/pi-manager.js";
import type { PiEvent, PiProcess } from "../../runtime/pi/pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../../runtime/pi/pi-runtime-launch.js";
import type { WorkspaceEnvironmentService } from "../../runtime/workspace/workspace-environment.js";

export interface ManagedPiToolResult {
  details: unknown;
  model_tokens: number;
  cost_usd: number;
  session_id?: string;
}

export class PiManagedResearchRuntime {
  private readonly active = new Map<string, { process: PiProcess; managerKey: string; researchId: string }>();

  constructor(
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
    private readonly manager: PiManager,
  ) {}

  async run(input: { cwd: string; research_id: string; operation_id: string; role: string; expected_tool: string; prompt: string; timeout_ms?: number }): Promise<ManagedPiToolResult> {
    const sessionDir = join(metadataRoot(input.cwd), "research-runtimes", input.research_id, input.role);
    await mkdir(sessionDir, { recursive: true });
    const options = buildPiProcessOptions(input.cwd, loadDefaultPiConfig(), undefined, await this.environments.environment(input.cwd), sessionDir);
    if (!options) throw new Error("Pi CLI is not configured");
    options.requestTimeoutMs = 30_000;
    const managerKey = `research:${input.role}:${input.operation_id}`;
    const process = await this.manager.start(managerKey, options);
    this.active.set(input.operation_id, { process, managerKey, researchId: input.research_id });
    let settled: (() => void) | null = null;
    let rejected: ((error: Error) => void) | null = null;
    let captured: unknown;
    let captures = 0;
    let modelTokens = 0;
    let costUsd = 0;
    process.on("event", (event: PiEvent) => {
      if (event.type === "message_end") {
        const message = asRecord(event.message);
        const usage = asRecord(message?.usage);
        modelTokens += Number(usage?.input ?? 0) + Number(usage?.output ?? 0);
        costUsd += Number(asRecord(usage?.cost)?.total ?? 0);
      }
      if (event.type === "tool_execution_end" && event.toolName === input.expected_tool && event.isError !== true) {
        captures += 1;
        captured = asRecord(event.result)?.details;
        if (captures > 1) rejected?.(new Error(`${input.role} called ${input.expected_tool} more than once`));
      }
      if (event.type === "agent_settled") settled?.();
    });
    process.once("exit", () => rejected?.(new Error(`${input.role} runtime exited before completing`)));

    try {
      const state = await process.sendCommand("get_state");
      if (!state.success) throw new Error(String(state.error ?? `unable to initialize ${input.role} runtime`));
      const sessionId = typeof asRecord(state.data)?.sessionId === "string" ? String(asRecord(state.data)!.sessionId) : undefined;
      const completed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${input.role} runtime timed out`)), input.timeout_ms ?? 10 * 60_000);
        let done = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true; clearTimeout(timeout); settled = null; rejected = null;
          error ? reject(error) : resolve();
        };
        settled = () => finish(); rejected = (error) => finish(error);
      });
      const response = await process.sendCommand("prompt", { message: input.prompt });
      if (!response.success) (rejected as ((error: Error) => void) | null)?.(new Error(String(response.error ?? `${input.role} runtime rejected prompt`)));
      await completed;
      if (captures !== 1 || captured === undefined) throw new Error(`${input.role} did not return exactly one ${input.expected_tool} result`);
      return { details: captured, model_tokens: modelTokens, cost_usd: costUsd, ...(sessionId ? { session_id: sessionId } : {}) };
    } finally {
      process.removeAllListeners("event"); process.removeAllListeners("exit");
      this.active.delete(input.operation_id);
      await this.manager.stop(managerKey).catch(() => undefined);
    }
  }

  async cancel(operationId: string): Promise<void> {
    const active = this.active.get(operationId);
    if (active) await this.manager.stop(active.managerKey);
  }

  async cancelResearch(researchId: string): Promise<void> {
    await Promise.allSettled([...this.active.values()].filter((active) => active.researchId === researchId).map((active) => this.manager.stop(active.managerKey)));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((active) => this.manager.stop(active.managerKey)));
    this.active.clear();
  }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
}
