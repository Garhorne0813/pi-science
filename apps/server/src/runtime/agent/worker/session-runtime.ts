import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AgentHarness, BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv, createBashTool, createEditTool, createReadTool, createWriteTool, loadSkills, type AgentHarness as Harness, type AgentLane, type JsonlSessionMetadata, type Session, type WatchHandle, type LaneSnapshot, type Skill } from "@earendil-works/pi-agent-core/node";
import { agentModelCatalog, agentModels } from "./agent-models.js";
import { AgentCoreEventAdapter } from "../agent-event-adapter.js";
import { userPrompt } from "../agent-message.js";
import { notebookHarnessTools } from "./notebook-tools.js";
import { InteractionBridge } from "./interaction-bridge.js";
import { questionnaireHarnessTool } from "./questionnaire-tool.js";
import { AgentMcpTools } from "./mcp-tools.js";
import type { RuntimeEvent, RuntimeResult, RuntimeSkillPolicy } from "../agent-runtime-types.js";
import { metadataRoot } from "../../../storage/persistence.js";
import type { AgentRuntimeStartOptions } from "./protocol.js";
import { toolEnvironment } from "../agent-runtime-environment.js";

const context = BACKGROUND_CONTEXT;

function failure(error: unknown): RuntimeResult {
  return { success: false, code: "agent_runtime_error", error: error instanceof Error ? error.message : String(error) };
}

function resultValue(value: unknown): RuntimeResult {
  if (!value || typeof value !== "object") return { success: false, code: "invalid_result", error: "invalid AgentHarness result" };
  const result = value as { ok: boolean; value?: unknown; error?: { message?: string; code?: string } };
  return result.ok
    ? { success: true, data: result.value }
    : { success: false, code: result.error?.code ?? "agent_runtime_error", error: result.error?.message ?? "AgentHarness rejected the command" };
}

function applySkillPolicy(skills: Skill[], policy: RuntimeSkillPolicy): Skill[] {
  if (policy.mode === "none") return [];
  if (policy.mode === "inherit") return skills;
  const names = new Set(policy.skills);
  return skills.filter((skill) => policy.mode === "allowlist" ? names.has(skill.name) : !names.has(skill.name));
}

export class SessionRuntime {
  readonly sessionId: string;
  private readonly lane: AgentLane;
  private readonly harness: Harness;
  private readonly repo: JsonlSessionRepo;
  private readonly executionEnv: NodeExecutionEnv;
  private readonly metadata: JsonlSessionMetadata;
  private readonly session: Session<JsonlSessionMetadata>;
  private readonly fatal: (error: unknown) => void;
  private readonly watch: WatchHandle<LaneSnapshot>;
  private readonly interactions: InteractionBridge;
  private readonly mcp: AgentMcpTools;
  private readonly skillPaths: string[];
  private allSkills: Skill[];
  private skillPolicy: RuntimeSkillPolicy = { mode: "inherit" };
  private closed = false;
  private activated = false;
  private activateWatch: (() => void) | undefined;
  private mutationTail: Promise<unknown> = Promise.resolve();

  private constructor(
    sessionId: string,
    lane: AgentLane,
    harness: Harness,
    repo: JsonlSessionRepo,
    executionEnv: NodeExecutionEnv,
    metadata: JsonlSessionMetadata,
    session: Session<JsonlSessionMetadata>,
    watch: WatchHandle<LaneSnapshot>,
    interactions: InteractionBridge,
    mcp: AgentMcpTools,
    skillPaths: string[],
    allSkills: Skill[],
    skillPolicy: RuntimeSkillPolicy,
    fatal: (error: unknown) => void,
  ) {
    this.sessionId = sessionId;
    this.lane = lane;
    this.harness = harness;
    this.repo = repo;
    this.executionEnv = executionEnv;
    this.metadata = metadata;
    this.session = session;
    this.watch = watch;
    this.interactions = interactions;
    this.mcp = mcp;
    this.skillPaths = skillPaths;
    this.allSkills = allSkills;
    this.skillPolicy = skillPolicy;
    this.fatal = fatal;
  }

  static async open(options: AgentRuntimeStartOptions, publish: (event: RuntimeEvent) => void, fatal: (error: unknown) => void): Promise<SessionRuntime> {
    if (!isAbsolute(options.cwd) || resolve(options.cwd) !== options.cwd) throw new Error("worker cwd must be absolute and normalized");
    const requiredRoot = join(metadataRoot(options.cwd), "agent-sessions");
    if (resolve(options.sessionsRoot) !== resolve(requiredRoot)) throw new Error("agent sessions root must be workspace-local");
    const models = agentModels();
    const model = models.getModel(options.model.provider, options.model.modelId);
    if (!model) throw new Error(`model not found: ${options.model.provider}/${options.model.modelId}`);
    const environment = toolEnvironment(options.env ?? {});
    const executionEnv = new NodeExecutionEnv({ cwd: options.cwd, shellEnv: environment });
    const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: requiredRoot });
    const interactions = new InteractionBridge(publish);
    let mcp: AgentMcpTools | undefined;
    const skillPaths = [join(options.cwd, ".pi", "skills"), ...(options.skillPaths ?? [])];
    try {
      const session = options.sessionId
        ? await (async () => {
            const metadata = (await repo.list({ cwd: options.cwd }, context)).find((item) => item.id === options.sessionId);
            if (!metadata) throw new Error(`agent session not found: ${options.sessionId}`);
            return repo.open(metadata, context);
          })()
        : await repo.create({ cwd: options.cwd }, context);
      const discovered = await loadSkills(executionEnv, skillPaths, context);
      mcp = await AgentMcpTools.open(options.cwd, interactions, options.env ?? {});
      const skillPolicy = options.skillPolicy ?? { mode: "inherit" };
      const { harness, open } = await AgentHarness.create({
        session,
        models,
        model,
        thinkingLevel: options.thinking,
        tools: [createReadTool(), createBashTool({ prepare: (execution) => {
          execution.env = environment;
          execution.inheritEnv = false;
        } }), createEditTool(), createWriteTool(),
          ...notebookHarnessTools(options.cwd, session.metadata.id), questionnaireHarnessTool(interactions), ...mcp.tools],
        toolContext: { env: executionEnv },
        resources: { skills: applySkillPolicy(discovered.skills, skillPolicy) },
        systemPrompt: options.systemPrompt ?? "You are a helpful scientific research assistant.",
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
      }, context);
      const lane = await harness.lane("main", context);
      const watch = await lane.watch(context);
      const runtime = new SessionRuntime(session.metadata.id, lane, harness, repo, executionEnv, session.metadata, session, watch, interactions, mcp, skillPaths, discovered.skills, skillPolicy, fatal);
      const adapter = new AgentCoreEventAdapter();
      runtime.activateWatch = () => {
        watch.start((event) => {
          for (const mapped of adapter.adapt(event)) publish(mapped);
        });
        const recovered = open.find((operation) => operation.lane === "main");
        if (recovered) {
          // A just-accepted run resumes from "starting" without run_resume.
          // Seed its lifecycle from the durable snapshot after binding.
          if (recovered.kind === "run") publish(adapter.beginRecovery(recovered.operationId));
          void lane.resume(context).catch(fatal);
        }
      };
      return runtime;
    } catch (error) {
      interactions.close();
      await mcp?.close().catch(() => undefined);
      await repo.close(context).catch(() => undefined);
      await executionEnv.cleanup(context).catch(() => undefined);
      throw error;
    }
  }

  async command(type: string, params: Record<string, unknown>): Promise<RuntimeResult> {
    // Drive/resume run in the background; abort and interaction responses must
    // remain reachable while short admission/configuration mutations serialize.
    if (["abort", "steer", "follow_up"].includes(type)) return this.execute(type, params);
    const command = this.mutationTail.then(() => this.execute(type, params));
    this.mutationTail = command.catch(() => undefined);
    return command;
  }

  private async execute(type: string, params: Record<string, unknown>): Promise<RuntimeResult> {
    if (this.closed) return { success: false, code: "closed", error: "agent runtime is closed" };
    try {
      switch (type) {
        case "activate": {
          if (!this.activated) {
            this.activated = true;
            this.activateWatch?.();
          }
          return { success: true };
        }
        case "get_state": {
          const snapshot = await this.watch.resnapshot(context);
          return { success: true, data: {
            sessionId: this.sessionId,
            busy: snapshot.operation !== null,
            model: snapshot.configuration.model,
            thinkingLevel: snapshot.configuration.thinkingLevel,
            activeTools: snapshot.configuration.activeToolNames,
            operation: snapshot.operation,
            queues: snapshot.queues,
            faulted: snapshot.faulted,
          } };
        }
        case "prompt": {
          if (!this.activated) return { success: false, code: "not_ready", error: "agent runtime has not been activated" };
          const message = params.message;
          if (typeof message !== "string" || !message.trim()) return { success: false, code: "invalid_message", error: "prompt message is required" };
          const clientMessageId = typeof params.client_message_id === "string" ? params.client_message_id : undefined;
          const operationId = clientMessageId
            ? `prompt-${createHash("sha256").update(`${this.sessionId}\0${clientMessageId}`).digest("hex")}` : undefined;
          if (clientMessageId) {
            // Admission commits the user message and operation together. Read
            // the complete session, including branches no longer at the tip.
            const prior = (await this.session.findEntries(undefined, context)).find((entry) => entry.type === "message"
              && entry.message.role === "user" && entry.message.client_message_id === clientMessageId);
            if (prior?.type === "message" && prior.message.role === "user") {
              const content = prior.message.content;
              const text = typeof content === "string" ? content
                : content.every((part) => part.type === "text") ? content.map((part) => part.type === "text" ? part.text : "").join("") : null;
              if (text !== message) return { success: false, code: "client_message_id_conflict", error: "client_message_id was already used with different prompt content" };
              return { success: true, operationId, durableMessageId: prior.id, deduplicated: true };
            }
          }
          const admitted = await this.lane.accept({ kind: "prompt", operationId, prompt: userPrompt(message, clientMessageId) }, context);
          if (!admitted.ok) return resultValue(admitted);
          const acceptedId = admitted.value.operationId;
          void this.lane.drive({ operationId: acceptedId, waitForRetry: true, pollDeferred: true }, context)
            .catch(this.fatal); // A fresh worker resumes the durable operation.
          return { success: true, operationId: acceptedId };
        }
        case "steer":
        case "follow_up": {
          const message = params.message;
          if (typeof message !== "string" || !message.trim()) return { success: false, code: "invalid_message", error: "message is required" };
          return resultValue(type === "steer"
            ? await this.lane.steer(message, undefined, context)
            : await this.lane.followUp(message, undefined, context));
        }
        case "abort": return resultValue(await this.lane.abort(context));
        case "compact": {
          if (!this.activated) return { success: false, code: "not_ready", error: "agent runtime has not been activated" };
          const customInstructions = typeof params.customInstructions === "string" ? params.customInstructions : undefined;
          const admitted = await this.lane.accept({ kind: "compaction", customInstructions }, context);
          if (!admitted.ok) return resultValue(admitted);
          const operationId = admitted.value.operationId;
          void this.lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, context).catch(this.fatal);
          return { success: true, operationId };
        }
        case "configure":
        case "set_model":
        case "set_thinking_level": return await this.configure(type, params);
        case "get_available_thinking_levels":
          return { success: true, data: { levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } };
        case "get_available_models":
          return { success: true, data: { models: await agentModelCatalog() } };
        case "get_commands": return { success: true, data: { commands: [] } };
        case "get_skills": return { success: true, data: { skills: this.skillStatus(), policy: this.skillPolicy } };
        case "set_skill_policy": {
          const policy = params.policy as RuntimeSkillPolicy | undefined;
          if (!policy || !["inherit", "none", "allowlist", "denylist"].includes(policy.mode)
            || ((policy.mode === "allowlist" || policy.mode === "denylist") && !Array.isArray(policy.skills))) {
            return { success: false, code: "invalid_skill_policy", error: "invalid skill policy" };
          }
          this.skillPolicy = policy;
          await this.harness.setResources({ skills: this.enabledSkills() }, context);
          return { success: true, data: { skills: this.skillStatus(), policy } };
        }
        case "refresh_skills": {
          this.allSkills = (await loadSkills(this.executionEnv, this.skillPaths, context)).skills;
          await this.harness.setResources({ skills: this.enabledSkills() }, context);
          return { success: true, data: { skills: this.skillStatus(), policy: this.skillPolicy } };
        }
        case "get_entries": return { success: true, data: { entries: await this.lane.findEntries(undefined, context) } };
        case "get_messages": return { success: true, data: { messages: (await this.lane.findEntries(undefined, context)).filter((entry) => entry.type === "message") } };
        case "get_last_assistant_text": {
          const entries = await this.lane.findEntries(undefined, context);
          const assistant = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
          const content = assistant?.type === "message" && assistant.message.role === "assistant" ? assistant.message.content : [];
          return { success: true, data: { text: content.filter((part) => part.type === "text").map((part) => part.text).join("") } };
        }
        case "get_tree": {
          const entries = await this.session.findEntries(undefined, context);
          return { success: true, data: { entries: entries.map(({ id, parentId, type, timestamp }) => ({ id, parentId, type, timestamp })) } };
        }
        case "fork":
        case "clone": {
          const entryId = typeof params.entryId === "string" ? params.entryId : undefined;
          const forked = await this.repo.fork(this.metadata, type === "clone"
            ? { scope: "tree" }
            : { scope: "branch", branch: "main", entryId, position: "at" }, context);
          const id = forked.metadata.id;
          await forked.close(context);
          return { success: true, data: { sessionId: id }, sessionId: id };
        }
        case "get_session_stats": return { success: true, data: (await this.watch.resnapshot(context)).stats };
        case "set_session_name": {
          const name = params.name;
          await this.harness.setName(typeof name === "string" ? name : undefined, context);
          return { success: true };
        }
        default: return { success: false, code: "unsupported_command", error: `unsupported agent command: ${type}` };
      }
    } catch (error) {
      return failure(error);
    }
  }

  private async configure(type: string, params: Record<string, unknown>): Promise<RuntimeResult> {
    const before = await this.watch.resnapshot(context);
    if (before.operation) return { success: false, code: "busy", error: "agent is busy; wait for the current task to finish or stop it" };
    const model = type === "set_thinking_level" ? before.configuration.model
      : { provider: params.provider, modelId: params.modelId };
    if (typeof model.provider !== "string" || typeof model.modelId !== "string"
      || !agentModels().getModel(model.provider, model.modelId)) {
      return { success: false, code: "invalid_model", error: "model is not in the agent-core catalog" };
    }
    const ref = { provider: model.provider, modelId: model.modelId };
    const level = params.level ?? before.configuration.thinkingLevel;
    if (typeof level !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
      return { success: false, code: "invalid_thinking", error: "invalid thinking level" };
    }
    try {
      await this.lane.setModel(ref, context);
      await this.lane.setThinkingLevel(level as AgentRuntimeStartOptions["thinking"] & string, context);
    } catch (error) {
      try {
        await this.lane.setModel(before.configuration.model, context);
        await this.lane.setThinkingLevel(before.configuration.thinkingLevel, context);
      } catch (restoreError) {
        // Stop this worker rather than admit a new mutation against unknown
        // state. Reopening reads the durable lane configuration as authority.
        this.closed = true;
        this.fatal(restoreError);
        return { success: false, code: "reconcile_failed", error: "unable to restore the durable lane configuration" };
      }
      return failure(error);
    }
    const snapshot = await this.watch.resnapshot(context);
    return { success: true, data: { model: snapshot.configuration.model, thinkingLevel: snapshot.configuration.thinkingLevel } };
  }

  notify(type: string, params: Record<string, unknown>): RuntimeResult {
    return this.interactions.notify(type, params);
  }

  private enabledSkills(): Skill[] {
    return applySkillPolicy(this.allSkills, this.skillPolicy);
  }

  private skillStatus(): Array<{ name: string; description: string; filePath: string; enabled: boolean }> {
    const enabled = new Set(this.enabledSkills().map((skill) => skill.name));
    return this.allSkills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath,
      enabled: enabled.has(skill.name) }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.interactions.close();
    this.watch.unsubscribe();
    await this.mutationTail;
    await this.harness.close(context);
    await this.mcp.close();
    await this.repo.close(context);
    await this.executionEnv.cleanup(context);
  }
}
