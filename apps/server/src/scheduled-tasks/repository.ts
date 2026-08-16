import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scheduledTaskRunSchema, scheduledTaskSchema, type ScheduledTask, type ScheduledTaskRun } from "@pi-science/contracts";
import { metadataRoot, readJson, withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";

/** File-per-record storage under `.pi-science/scheduled-tasks/`: tasks, runs
 *  and run logs. All writes go through withFileWriteLock; ids are system
 *  generated (task-<hex>/run-<hex>), so file names need no escaping. */
export class ScheduledTaskRepository {
  constructor(readonly cwd: string) {}

  private root(): string { return join(metadataRoot(this.cwd), "scheduled-tasks"); }
  private taskPath(taskId: string): string { return join(this.root(), "tasks", `${taskId}.json`); }
  private runPath(runId: string): string { return join(this.root(), "runs", `${runId}.json`); }
  logPath(runId: string): string { return join(this.root(), "logs", `${runId}.log`); }

  async listTasks(): Promise<ScheduledTask[]> {
    const entries = await readdir(join(this.root(), "tasks")).catch(() => []);
    const tasks: ScheduledTask[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const task = await this.getTask(entry.slice(0, -5)).catch(() => null);
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getTask(taskId: string): Promise<ScheduledTask | null> {
    const raw = await readJson<unknown>(this.taskPath(taskId), null);
    if (raw === null) return null;
    return scheduledTaskSchema.parse(raw);
  }

  async saveTask(task: ScheduledTask): Promise<void> {
    const path = this.taskPath(task.task_id);
    await withFileWriteLock(path, () => writeJsonAtomic(path, scheduledTaskSchema.parse(task)));
  }

  async deleteTask(taskId: string): Promise<void> {
    const path = this.taskPath(taskId);
    await withFileWriteLock(path, () => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }));
  }

  async listRuns(taskId: string, limit: number): Promise<ScheduledTaskRun[]> {
    const entries = await readdir(join(this.root(), "runs")).catch(() => []);
    const runs: ScheduledTaskRun[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const run = await readJson<unknown>(this.runPath(entry.slice(0, -5)), null).catch(() => null);
      if (run === null) continue;
      try {
        const parsed = scheduledTaskRunSchema.parse(run);
        if (parsed.task_id === taskId) runs.push(parsed);
      } catch { /* skip a corrupt run record */ }
    }
    return runs.sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for)).slice(0, limit);
  }

  async getRun(runId: string): Promise<ScheduledTaskRun | null> {
    const raw = await readJson<unknown>(this.runPath(runId), null);
    if (raw === null) return null;
    return scheduledTaskRunSchema.parse(raw);
  }

  async saveRun(run: ScheduledTaskRun): Promise<void> {
    const path = this.runPath(run.run_id);
    await withFileWriteLock(path, () => writeJsonAtomic(path, scheduledTaskRunSchema.parse(run)));
  }

  async appendLog(runId: string, line: string): Promise<void> {
    const path = this.logPath(runId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
  }
}
