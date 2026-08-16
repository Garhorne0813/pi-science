import { resolve } from "node:path";
import { ScheduledTaskCoordinator } from "./coordinator.js";
import { registry, type ExecutorKind, type ScheduledTaskExecutor } from "./executors.js";
import { ScheduledTaskRepository } from "./repository.js";

/** Resolves the per-workspace coordinator for a validated workspace path.
 *  ScheduledTaskCoordinator is per-workspace (its repository, ticker and run
 *  leases are bound to one cwd), so the control plane keeps one coordinator
 *  per workspace instead of a global singleton. */
export interface ScheduledTaskCoordinatorProvider {
  coordinatorFor(cwd: string): ScheduledTaskCoordinator;
  shutdown(): Promise<void>;
}

export class ScheduledTaskCoordinatorManager implements ScheduledTaskCoordinatorProvider {
  private readonly coordinators = new Map<string, ScheduledTaskCoordinator>();
  private readonly executors: Partial<Record<ExecutorKind, ScheduledTaskExecutor>>;

  constructor(executors: Partial<Record<ExecutorKind, ScheduledTaskExecutor>> = registry) {
    this.executors = executors;
  }

  /** Lazily creates and starts (ticker) the coordinator for a workspace and
   *  caches it; the executor map is shared read-only across workspaces. */
  coordinatorFor(cwd: string): ScheduledTaskCoordinator {
    const workspace = resolve(cwd);
    let coordinator = this.coordinators.get(workspace);
    if (!coordinator) {
      coordinator = new ScheduledTaskCoordinator({
        cwd: workspace,
        repository: new ScheduledTaskRepository(workspace),
        executors: this.executors,
      });
      this.coordinators.set(workspace, coordinator);
      coordinator.start();
    }
    return coordinator;
  }

  async shutdown(): Promise<void> {
    const coordinators = [...this.coordinators.values()];
    this.coordinators.clear();
    await Promise.allSettled(coordinators.map((coordinator) => coordinator.shutdown()));
  }
}
