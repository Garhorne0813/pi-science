import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { metadataRoot } from "../storage/persistence.js";
import { PiManager, piManager } from "../runtime/pi/pi-manager.js";
import { OrbitTaskRuntime } from "../runtime/pi/orbit-task-runtime.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../runtime/pi/pi-runtime-launch.js";
import type { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import type { TaskRuntime as AgentRuntime } from "../runtime/agent/runner-transport.js";
import { ReviewTaskRunner } from "./task-runner.js";

export class PiReviewSubagentRunner extends ReviewTaskRunner {
  constructor(environments: Pick<WorkspaceEnvironmentService, "environment">, private readonly manager: PiManager = piManager) { super(environments); }
  protected async startProcess(cwd: string, managerKey: string, owner: string): Promise<AgentRuntime> {
    const sessionDir = join(metadataRoot(cwd), "review-sessions", owner);
    await mkdir(sessionDir, { recursive: true });
    const options = buildPiProcessOptions(cwd, loadDefaultPiConfig(), undefined, await this.environments.environment(cwd));
    if (!options) throw new Error("Pi CLI is not configured");
    const index = options.args.indexOf("--session-dir");
    if (index >= 0) options.args[index + 1] = sessionDir;
    if (options.web) options.web.runtime.sessionDir = sessionDir;
    options.requestTimeoutMs = 30_000;
    return new OrbitTaskRuntime(await this.manager.start(managerKey, options));
  }

  protected stopProcess(key: string): Promise<void> { return this.manager.stop(key); }

}
