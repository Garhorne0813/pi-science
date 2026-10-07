import type { CreateSessionRequest, PiConfig, SessionState, SessionStats } from "@pi-science/contracts";
import { resolve } from "node:path";
import { ConversationEventHub, conversationEventHub } from "../events/conversation-event-hub.js";
import { durableEventStore } from "../events/event-store.js";
import type { RuntimeResult, RuntimeSkillPolicy } from "../agent/agent-runtime-types.js";
import { AgentCoreSessionService } from "../agent/agent-core-session-service.js";
import { agentModelCatalog, agentModels } from "../agent/worker/agent-models.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { loadDefaultPiConfig } from "../agent/runtime-config.js";
import { canonicalRuntimeModelRef } from "../agent/model-ref.js";
import type { ProjectReviewService } from "../../project-review/service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { SessionRepository, sessionRepository } from "./session-repository.js";
import { loadSessionStats, saveSessionStats } from "./session-stats-repository.js";
import { foldEventRecordsTiming, maxTiming, mergeSessionStats, SessionStatsProjector, timingFromStats, type SessionTiming } from "./session-stats-projector.js";
import { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { ensureProject } from "../../project/project-registry.js";
import type { ModelResourceService } from "../../model-resources/model-resource-service.js";

type RuntimeFailure = { error: string; code: string };
type StatsEventStore = { readAfter(cwd: string, sessionId: string, lastEventId?: string | null): Promise<Array<{ created_at: string; data: string }>> };
function runtimeKey(cwd: string, sessionId: string): string { return `${resolve(cwd)}\0${sessionId}`; }
function effectiveConfig(requested?: Partial<PiConfig>): PiConfig {
  const defaults = loadDefaultPiConfig();
  const rawModel = requested?.model || defaults.model || null;
  const model = rawModel ? canonicalRuntimeModelRef(rawModel) : null;
  return {
    model,
    provider: requested?.provider || defaults.provider || null,
    api_key: requested?.api_key || null,
    // A thinking level has no stable meaning until a model is configured;
    // Pi may normalize it differently for its placeholder unknown model.
    thinking: model ? (requested?.thinking ?? defaults.thinking ?? "high") : null,
    compaction_enabled: requested?.compaction_enabled ?? defaults.compaction_enabled ?? true,
    compaction_threshold_percent: requested?.compaction_threshold_percent ?? defaults.compaction_threshold_percent,
    model_context_window: requested?.model_context_window ?? defaults.model_context_window,
    model_context_window_override: requested?.model_context_window_override ?? defaults.model_context_window_override,
    model_max_output_tokens: requested?.model_max_output_tokens ?? defaults.model_max_output_tokens,
    skills: requested?.skills?.length ? requested.skills : defaults.skills,
    extensions: requested?.extensions?.length ? requested.extensions : defaults.extensions,
  };
}

/** Commands a person is waiting on. They skip the conversion wait once the
 *  session is genuinely ready, so they never queue behind an unrelated mutation. */
const CONTROL_COMMANDS = new Set(["abort", "steer", "follow_up"]);

/** The product session facade uses Agent Core exclusively. Legacy JSONL is data, never a runtime fallback. */
export class NodeSessionService {
  private readonly agentCore: AgentCoreSessionService;
  private readonly autoReviews = new Set<string>();
  private readonly statsProjector = new SessionStatsProjector();
  private log: (level: "info" | "warn" | "error", message: string) => void = () => {};
  constructor(
    private readonly eventHub: ConversationEventHub = conversationEventHub,
    private readonly repository: SessionRepository = sessionRepository,
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment"> = new WorkspaceEnvironmentService(),
    private readonly projectReview: Pick<ProjectReviewService, "run"> | null = null,
    private readonly statsEventStore: StatsEventStore = durableEventStore,
    private readonly modelResources: Pick<ModelResourceService, "ensureMigrated" | "isModelAvailable"> | null = null,
    agentCoreServer: { backendUrl?: string; internalToken?: string } = {},
  ) {
    this.agentCore = new AgentCoreSessionService(eventHub, environments, agentCoreServer);
    this.agentCore.configureProductLifecycle({
      observe: (cwd, sessionId, event) => this.statsProjector.track(runtimeKey(cwd, sessionId), event, Date.now()),
      settled: (cwd, sessionId, turnId) => this.scheduleAutoReview(cwd, sessionId, turnId),
      stats: async (cwd, sessionId, counters) => {
        const checkpoint = await loadSessionStats(cwd, sessionId).catch(() => null);
        const timing = this.statsProjector.timingWithCheckpoint(runtimeKey(cwd, sessionId), timingFromStats(checkpoint));
        const stats = mergeSessionStats({ ...counters }, maxTiming(timing, await this.backfillTiming(cwd, sessionId)));
        await saveSessionStats(cwd, sessionId, stats);
        return stats;
      },
    });
  }


  configureLogging(log: (level: "info" | "warn" | "error", message: string) => void): void { this.log = log; }
  configureBeforeRuntimeStart(hook: ((cwd: string) => Promise<void>) | null): void { this.agentCore.configureBeforeStart(hook); }

  async create(body: CreateSessionRequest): Promise<{ id: string; cwd: string; project_id: string } | RuntimeFailure> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(body.cwd); }
    catch (error) { return { error: String(error), code: "workspace_invalid" }; }
    const migration = await this.ensureModelResources();
    if (migration) return migration;
    const project = await ensureProject(cwd);
    const created = await this.agentCore.create(cwd, effectiveConfig(body.config));
    return "error" in created ? created : { id: created.id, cwd, project_id: project.id };
  }

  private async prepare(cwdValue: string, sessionId: string, waitForConversion = true): Promise<{ cwd: string } | RuntimeResult> {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(cwdValue); }
    catch (error) { return { success: false, error: String(error), code: "workspace_invalid" }; }
    const migration = await this.ensureModelResources();
    if (migration) return { success: false, ...migration };
    // A conversion registers ownership before it finishes, so an owned session
    // can still be mid-conversion. Reads must wait for it, and so must a control
    // command: opening a worker on a half-converted transcript would race the
    // conversion. Only a session that is genuinely ready skips the wait.
    if (!waitForConversion && await this.agentCore.ready(cwd, sessionId)) return { cwd };
    await this.agentCore.waitForMutation(cwd, sessionId);
    if (await this.agentCore.owns(cwd, sessionId)) return { cwd };
    const source = await this.repository.findPath(cwd, sessionId);
    if (!source) return { success: false, code: "not_found", error: "session not found in this workspace" };
    const imported = await this.agentCore.importLegacy(cwd, sessionId, source, effectiveConfig(), { activate: false });
    return imported.success ? { cwd } : imported;
  }

  async prepareHistory(cwdValue: string, sessionId: string): Promise<RuntimeResult> {
    const prepared = await this.prepare(cwdValue, sessionId);
    return "success" in prepared ? prepared : { success: true };
  }

  async command(sessionId: string, cwdValue: string, type: string, params: Record<string, unknown> = {}): Promise<RuntimeResult> {
    const prepared = await this.prepare(cwdValue, sessionId, !CONTROL_COMMANDS.has(type));
    if ("success" in prepared) return prepared;
    const result = await this.agentCore.command(prepared.cwd, sessionId, type, params, effectiveConfig());
    return result.success && (result.data as { cancelled?: boolean } | undefined)?.cancelled
      ? { ...result, success: false, code: "cancelled", error: "operation cancelled" } : result;
  }
  async notify(sessionId: string, cwdValue: string, type: string, params: Record<string, unknown>): Promise<RuntimeResult> {
    const prepared = await this.prepare(cwdValue, sessionId, false);
    return "success" in prepared ? prepared : this.agentCore.notify(prepared.cwd, sessionId, type, params);
  }
  async fork(sessionId: string, cwdValue: string, entryId?: string): Promise<RuntimeResult> {
    const prepared = await this.prepare(cwdValue, sessionId);
    return "success" in prepared ? prepared : this.agentCore.fork(prepared.cwd, sessionId, entryId, effectiveConfig());
  }
  async configure(sessionId: string, cwdValue: string, model: string, thinking?: string): Promise<RuntimeResult> {
    const prepared = await this.prepare(cwdValue, sessionId);
    return "success" in prepared ? prepared : this.agentCore.configure(prepared.cwd, sessionId, model, thinking, effectiveConfig());
  }
  async resume(sessionId: string, cwdValue: string): Promise<RuntimeResult> {
    const prepared = await this.prepare(cwdValue, sessionId);
    return "success" in prepared ? prepared : this.agentCore.resume(prepared.cwd, sessionId, effectiveConfig());
  }
  async state(sessionId: string, cwdValue: string): Promise<SessionState | RuntimeFailure> {
    const prepared = await this.prepare(cwdValue, sessionId);
    return "success" in prepared ? { error: prepared.error ?? "session unavailable", code: prepared.code ?? "runtime_error" }
      : this.agentCore.state(prepared.cwd, sessionId, effectiveConfig());
  }
  async stats(sessionId: string, cwdValue: string): Promise<{ stats: SessionStats } | RuntimeFailure> {
    const prepared = await this.prepare(cwdValue, sessionId);
    return "success" in prepared ? { error: prepared.error ?? "session unavailable", code: prepared.code ?? "runtime_error" }
      : this.agentCore.stats(prepared.cwd, sessionId);
  }
  async exists(sessionId: string, cwdValue: string): Promise<boolean> {
    try { return (await this.repository.findPath(await validateWorkspaceCwd(cwdValue), sessionId)) !== null; }
    catch { return false; }
  }
  async delete(sessionId: string, cwdValue: string): Promise<RuntimeResult> {
    const prepared = await this.prepare(cwdValue, sessionId);
    if ("success" in prepared) return prepared.code === "not_found" ? { success: true } : prepared;
    return this.agentCore.delete(prepared.cwd, sessionId);
  }
  liveSessions(cwdValue: string): Array<{ id: string; cwd: string }> {
    try { return this.agentCore.liveSessions(resolve(cwdValue)); } catch { return []; }
  }
  liveSession(cwdValue: string): { id: string; cwd: string } | null { return this.liveSessions(cwdValue)[0] ?? null; }
  activeSessionId(cwdValue: string): string | null { return this.liveSession(cwdValue)?.id ?? null; }
  async availableModels(cwdValue: string): Promise<RuntimeResult> {
    try { await validateWorkspaceCwd(cwdValue); } catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    return { success: true, data: { models: await agentModelCatalog() } };
  }
  async availableThinkingLevels(cwdValue: string, expectedModel?: string): Promise<RuntimeResult> {
    try { await validateWorkspaceCwd(cwdValue); } catch (error) { return { success: false, code: "workspace_invalid", error: String(error) }; }
    if (expectedModel) {
      const separator = expectedModel.indexOf("/");
      const model = agentModels().getModel(expectedModel.slice(0, separator), expectedModel.slice(separator + 1));
      return model ? { success: true, data: { model: expectedModel, levels: getSupportedThinkingLevels(model) } }
        : { success: false, code: "invalid_model", error: "model is unavailable" };
    }
    const runtime = this.agentCore.liveRuntime(resolve(cwdValue));
    return runtime ? runtime.sendCommand("get_available_thinking_levels") : { success: false, code: "not_found", error: "no live agent runtime" };
  }
  async reloadConfiguration(modelChange?: { model: string; thinking: string }): Promise<Array<{ cwd: string; oldId: string; newId: string }>> {
    await this.agentCore.reloadConfiguration(modelChange); return [];
  }
  setGlobalSkillPolicy(policy: RuntimeSkillPolicy): Promise<void> { return this.agentCore.setGlobalSkillPolicy(policy); }
  refreshAllRuntimeSkills(): Promise<void> { return this.agentCore.refreshAllSkills(); }
  async shutdownAll(): Promise<void> { await this.agentCore.shutdownAll(); await this.eventHub.flush(); }
  get activeCount(): number { return this.agentCore.processCount; }
  get processCount(): number { return this.agentCore.processCount; }
  private async ensureModelResources(): Promise<RuntimeFailure | null> {
    if (!this.modelResources) return null;
    try {
      await this.modelResources.ensureMigrated();
      return null;
    } catch (error) {
      return { error: `unable to migrate model resources: ${error instanceof Error ? error.message : String(error)}`, code: "model_resources_migration_failed" };
    }
  }

  private async backfillTiming(cwd: string, sessionId: string): Promise<SessionTiming | null> {
    try {
      const records = await this.statsEventStore.readAfter(cwd, sessionId);
      if (!records || records.length === 0) return null;
      return foldEventRecordsTiming(records);
    } catch {
      return null;
    }
  }

  private scheduleAutoReview(cwd: string, sessionId: string, turnId?: string): void {
    const review = this.projectReview;
    if (!review || !sessionId) return;
    const key = runtimeKey(cwd, sessionId);
    if (this.autoReviews.has(key)) return;
    this.autoReviews.add(key);
    void review.run(cwd, { sessionId, trigger: "auto", ...(turnId ? { turnId } : {}) })
      .catch((error: unknown) => this.log("warn", `automatic project review failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.autoReviews.delete(key));
  }

}

export const nodeSessionService = new NodeSessionService();
