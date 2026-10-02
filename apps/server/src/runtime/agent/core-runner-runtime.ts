import { CredentialStore } from "../../model-resources/credential-store.js";
import { projectedEnvironmentNames } from "../pi/extensions/pi-science-mcp.js";
import { loadDefaultPiConfig, seedWorkspaceAssets } from "../pi/pi-runtime-launch.js";
import { configPath, readJson } from "../../storage/persistence.js";
import { openHiddenTask, hiddenSessionsRoot, runHiddenPrompt } from "./hidden-agent-task.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { RuntimeSkillPolicy } from "./agent-runtime-types.js";
import type { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import type { TaskRuntime, TaskPrompt } from "./runner-transport.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";

/** Uses the durable child result directly; no synthetic Orbit stream. */
class CoreTaskRuntime implements TaskRuntime {
  private tokens = 0;
  private cost = 0;
  constructor(private readonly runtime: AgentCoreRuntimeClient) {}
  async initialize(): Promise<void> { /* openHiddenTask already initialized the worker. */ }
  async prompt(request: TaskPrompt): Promise<string> {
    const report = (tokens: number, cost: number) => {
      this.tokens += tokens; this.cost += cost;
      request.onUsage?.({ model_tokens: tokens, cost_usd: cost });
    };
    try {
      return await runHiddenPrompt(this.runtime, request.message, request.clientMessageId, request.deadline, (event) => {
        if (event.type !== "message.completed") return;
        const usage = (event.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined)?.usage;
        report((usage?.input ?? 0) + (usage?.output ?? 0), usage?.cost?.total ?? 0);
      });
    } finally {
      // Replay may have no live usage events; durable totals also retain failure spend.
      const stats = await this.runtime.sendCommand("get_session_stats").catch(() => undefined);
      const usage = stats?.success ? stats.data?.usage : undefined;
      if (usage) report(Math.max(0, usage.totalTokens - this.tokens), Math.max(0, usage.cost.total - this.cost));
    }
  }
}

export async function openCoreRunner(manager: AgentRuntimeManager, environments: Pick<WorkspaceEnvironmentService, "environment">,
  cwd: string, key: string, owner: string, purpose: "research" | "review", server: { backendUrl?: string; internalToken?: string } = {}): Promise<TaskRuntime> {
  await new ModelResourceService().ensureMigrated();
  const config = loadDefaultPiConfig();
  const index = config.model?.indexOf("/") ?? -1;
  if (index <= 0) throw new Error("Agent-core runner requires a configured model");
  seedWorkspaceAssets(cwd);
  const credentials = await new CredentialStore().listMetadata();
  const credentialEnvNames = [...new Set([...credentials.flatMap((item) => item.backend === "environment" && item.environment_variable ? [item.environment_variable] : []), ...projectedEnvironmentNames(cwd)])];
  const settings = await readJson<{ skill_policy?: RuntimeSkillPolicy }>(configPath("config.json"), {});
  const runtime = await openHiddenTask(manager, `${purpose}:${cwd}:${key}`, {
    cwd, sessionsRoot: hiddenSessionsRoot(cwd), model: { provider: config.model!.slice(0, index), modelId: config.model!.slice(index + 1) },
    settings: config, thinking: config.thinking as "off" | "high" | undefined, skillPaths: config.skills,
    skillPolicy: settings.skill_policy ?? { mode: "inherit" }, credentialEnvNames,
    env: { ...await environments.environment(cwd), ...(server.backendUrl ? { PI_SCIENCE_BACKEND_URL: server.backendUrl } : {}),
      ...(server.internalToken ? { PI_SCIENCE_INTERNAL_TOKEN: server.internalToken } : {}) },
    allowedTools: purpose === "review" ? [] : ["read", "subagent"],
    systemPrompt: purpose === "review" ? "You are a scientific project reviewer. Return only the requested JSON. Do not use tools."
      : "You are a research supervisor. Delegate planning, candidate production, and review to subagents. Do not edit files or execute code.",
  }, `${purpose}:${owner}`, purpose);
  return new CoreTaskRuntime(runtime);
}
