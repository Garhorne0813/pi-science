import { EventEmitter } from "node:events";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { projectedEnvironmentNames } from "../pi/extensions/pi-science-mcp.js";
import { loadDefaultPiConfig, seedWorkspaceAssets } from "../pi/pi-runtime-launch.js";
import { configPath, readJson } from "../../storage/persistence.js";
import { openHiddenTask, hiddenSessionsRoot, runHiddenPrompt } from "./hidden-agent-task.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntime, RuntimeResult, RuntimeSkillPolicy } from "./agent-runtime-types.js";
import type { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import type { RunnerTransport } from "./runner-transport.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";

/** Transport only: research and review keep their own runner policies and state machines. */
class CoreRunnerRuntime extends EventEmitter implements AgentRuntime {
  readonly durablePrompts = true;
  private tokens = 0;
  private cost = 0;
  constructor(private readonly runtime: AgentCoreRuntimeClient) { super(); }
  get sessionId(): string { return this.runtime.sessionId; }
  get cwd(): string { return this.runtime.cwd; }
  get isClosed(): boolean { return this.runtime.isClosed; }
  async sendCommand(type: string, params: Record<string, unknown> = {}): Promise<RuntimeResult> {
    if (type !== "prompt") return this.runtime.sendCommand(type, params);
    void runHiddenPrompt(this.runtime, String(params.message), String(params.client_message_id), Date.now() + 10 * 60_000,
      (event) => {
        if (event.type !== "message_end") return;
        const message = event.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined;
        this.tokens += (message?.usage?.input ?? 0) + (message?.usage?.output ?? 0);
        this.cost += message?.usage?.cost?.total ?? 0;
        this.emit("event", event);
      })
      .then(async (text) => {
        const stats = await this.runtime.sendCommand("get_session_stats");
        const usage = (stats.data as { usage?: { totalTokens: number; cost: { total: number } } } | undefined)?.usage;
        if (usage && (usage.totalTokens > this.tokens || usage.cost.total > this.cost)) {
          this.emit("event", { type: "message_end", message: { usage: { input: Math.max(0, usage.totalTokens - this.tokens), output: 0,
            cost: { total: Math.max(0, usage.cost.total - this.cost) } } } });
          this.tokens = usage.totalTokens; this.cost = usage.cost.total;
        }
        this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
        this.emit("event", { type: "agent_settled" });
      }).catch((error) => { this.emit("stderr", String(error)); this.emit("exit", { code: 1, signal: null }); });
    return { success: true };
  }
  sendNotification(type: string, params?: Record<string, unknown>): Promise<void> { return this.runtime.sendNotification(type, params); }
  getSkills(): Promise<RuntimeResult> { return this.runtime.getSkills(); }
  setSkillPolicy(policy: RuntimeSkillPolicy): Promise<RuntimeResult> { return this.runtime.setSkillPolicy(policy); }
  refreshSkills(): Promise<RuntimeResult> { return this.runtime.refreshSkills(); }
  shutdown(): Promise<void> { return this.runtime.shutdown(); }
}

export async function openCoreRunner(manager: AgentRuntimeManager, environments: Pick<WorkspaceEnvironmentService, "environment">,
  cwd: string, key: string, owner: string, purpose: "research" | "review", server: { backendUrl?: string; internalToken?: string } = {}): Promise<RunnerTransport> {
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
  return new CoreRunnerRuntime(runtime);
}
