import { ReviewTaskRunner } from "./task-runner.js";
import { AgentRuntimeManager } from "../runtime/agent/agent-runtime-manager.js";
import { openCoreRunner } from "../runtime/agent/core-runner-runtime.js";
import type { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import type { TaskRuntime as AgentRuntime } from "../runtime/agent/runner-transport.js";

export class CoreReviewSubagentRunner extends ReviewTaskRunner {
  private readonly core = new AgentRuntimeManager();
  private readonly keys = new Map<string, string>();
  constructor(environments: Pick<WorkspaceEnvironmentService, "environment">,
    private readonly server: { backendUrl?: string; internalToken?: string } = {}) { super(environments); }
  protected override async startProcess(cwd: string, key: string, owner: string): Promise<AgentRuntime> {
    this.keys.set(key, `review:${cwd}:${key}`);
    return openCoreRunner(this.core, this.environments, cwd, key, owner, "review", this.server);
  }
  protected override async stopProcess(key: string): Promise<void> {
    const actual = this.keys.get(key); if (actual) await this.core.stop(actual);
    this.keys.delete(key);
  }
}
