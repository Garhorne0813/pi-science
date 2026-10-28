import { MemoryService } from "../memory/service.js";
import { MemoryBackground } from "../memory/background.js";
import { ConversationEventHub } from "../runtime/events/conversation-event-hub.js";
import { NodeSessionService } from "../runtime/node/node-session-service.js";
import type { RuntimeCatalogService } from "../runtime/agent/runtime-catalog.js";
import { AgentCoreCatalogService } from "../runtime/agent/agent-core-catalog.js";
import { SessionRepository } from "../runtime/node/session-repository.js";
import { SettingsStore } from "../storage/settings-store.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";
import { JobCoordinator } from "../runtime/jobs/job-coordinator.js";
import type { ServerConfig } from "../config/config.js";
import { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { NodeKernelManager } from "../runtime/kernel/node-kernel-manager.js";
import { NotebookService } from "../runtime/notebooks/notebook-service.js";
import { configPath } from "../storage/persistence.js";
import { EnvironmentRepository } from "../storage/sqlite/repositories/environment-repository.js";
import { JobRepository } from "../storage/sqlite/repositories/job-repository.js";
import { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import { SqliteStateStore } from "../storage/sqlite/state-store.js";
import { McpRepository } from "../storage/sqlite/repositories/mcp-repository.js";
import { McpConnectorService } from "../mcp/connector-service.js";
import { McpRuntimeProjection } from "../mcp/runtime-projection.js";

export interface ServerModules {
  readonly sessions: NodeSessionService;
  readonly events: ConversationEventHub;
  readonly sessionRepository: SessionRepository;
  readonly runtimeCatalog: Pick<RuntimeCatalogService, "getCatalog">;
  readonly settings: SettingsStore;
  readonly modelResources: ModelResourceService;
  readonly jobs: JobCoordinator;
  readonly environments: WorkspaceEnvironmentService;
  readonly kernels: NodeKernelManager;
  readonly notebooks: NotebookService;
  readonly memory: MemoryService;
  readonly memoryBackground: MemoryBackground;
  readonly stateStore: SqliteStateStore;
  readonly workspaces: WorkspaceRepository;
  readonly environmentRepository: EnvironmentRepository;
  readonly jobRepository: JobRepository;
  readonly sqliteEnabled: boolean;
  readonly mcp: McpConnectorService;
}

export interface ServerModuleOptions {
  sqliteEnabled?: boolean;
  stateStore?: SqliteStateStore;
}

/** Creates an app-owned module graph. No mutable runtime state is shared across apps. */
export function createServerModules(config?: ServerConfig, options: ServerModuleOptions = {}): ServerModules {
  const configuredSqlite = process.env.PI_SCIENCE_SQLITE_STATE;
  const sqliteEnabled = options.sqliteEnabled
    ?? (configuredSqlite === "1" || (configuredSqlite !== "0" && process.env.NODE_ENV !== "test"));
  const stateStore = options.stateStore ?? new SqliteStateStore({ path: sqliteEnabled ? configPath("state.sqlite") : ":memory:" });
  const workspaces = new WorkspaceRepository(stateStore);
  const environmentRepository = new EnvironmentRepository(stateStore);
  const jobRepository = new JobRepository(stateStore, workspaces);
  const events = new ConversationEventHub();
  const sessionRepository = new SessionRepository();
  const runtimeCatalog = new AgentCoreCatalogService();
  const environments = new WorkspaceEnvironmentService(undefined, config?.micromambaExecutable, sqliteEnabled ? environmentRepository : undefined);
  const kernels = new NodeKernelManager();
  const notebooks = new NotebookService({
    micromambaExecutable: config?.micromambaExecutable,
    micromambaResolver: () => environments.ensureMicromambaExecutable(),
    environments,
  });
  const settings = new SettingsStore();
  const modelResources = new ModelResourceService({ settings, runtimeCatalog });
  const coreServer = { backendUrl: config ? `http://127.0.0.1:${config.port}` : undefined, internalToken: config?.internalToken, onWorkerExit: (cwd: string, owner: string) => kernels.shutdownOwner(cwd, owner), hasApprovalResources: (cwd: string, owner: string) => kernels.hasOwner(cwd, owner), revokeApprovalResources: (cwd: string, owner: string) => kernels.revokeOwner(cwd, owner) };
  const memory = new MemoryService(stateStore, workspaces, sqliteEnabled || process.env.NODE_ENV === "test");
  const sessions = new NodeSessionService(events, sessionRepository, environments, null, undefined, modelResources, {
    backendUrl: config ? `http://127.0.0.1:${config.port}` : undefined,
    internalToken: config?.internalToken,
    onWorkerExit: coreServer.onWorkerExit,
  });
  const mcpRepository = new McpRepository(stateStore);
  const mcp = new McpConnectorService(mcpRepository, workspaces, settings, sessions, new McpRuntimeProjection(mcpRepository));
  if (sqliteEnabled) sessions.configureBeforeRuntimeStart((cwd) => mcp.materializeWorkspace(cwd));
  const jobs = new JobCoordinator(environments, {}, undefined, sqliteEnabled ? jobRepository : undefined);
  const memoryBackground = new MemoryBackground(memory, sessions, jobs);
  sessions.configureMemory({ settled: (cwd, sessionId) => memoryBackground.turnCompleted(cwd, sessionId), deleted: async (cwd, sessionId) => { const {context} = await memory.context(cwd); await memory.command(context, "frame.delete", {sessionId}); } });
  return { sessions, events, sessionRepository, runtimeCatalog, settings, modelResources, jobs, memory, memoryBackground, environments, kernels, notebooks, stateStore, workspaces, environmentRepository, jobRepository, sqliteEnabled, mcp };
}
