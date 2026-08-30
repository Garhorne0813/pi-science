import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provenanceRepository, type Provenance } from "./provenance-repository.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-provenance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

async function ledger(cwd: string): Promise<Provenance[]> {
  const lines = (await readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8")).trim().split(/\r?\n/);
  return lines.map((line) => JSON.parse(line) as Provenance);
}

describe("provenance repository", () => {
  it("increments version per path and leaves other paths untouched", async () => {
    const cwd = await workspace();
    const first = await provenanceRepository.record(cwd, { path: "report.md", tool: "writer" });
    const other = await provenanceRepository.record(cwd, { path: "data.csv", tool: "writer" });
    const second = await provenanceRepository.record(cwd, { path: "report.md", tool: "writer" });

    expect(first.version).toBe(1);
    expect(other.version).toBe(1);
    expect(second.version).toBe(2);

    const records = await ledger(cwd);
    expect(records.map((record) => [record.path, record.version])).toEqual([["report.md", 1], ["data.csv", 1], ["report.md", 2]]);
  });

  it("stores a 16-char content hash and truncates content to 100k chars", async () => {
    const cwd = await workspace();
    const long = "x".repeat(150_000);
    const record = await provenanceRepository.record(cwd, { path: "out.txt", content: long });

    expect(record.contentHash).toBe(createHash("sha256").update(long).digest("hex").slice(0, 16));
    expect(record.content).toHaveLength(100_000);
    // Non-string content must not produce hash or content fields.
    const noContent = await provenanceRepository.record(cwd, { path: "out.txt", content: 42 });
    expect(noContent.contentHash).toBeUndefined();
    expect(noContent.content).toBeUndefined();
    expect(noContent.version).toBe(2);
  });

  it("maps execution_id onto executionId and preserves session/tool fields", async () => {
    const cwd = await workspace();
    const record = await provenanceRepository.record(cwd, {
      path: "report.md",
      tool: "scheduled-task-service",
      execution_id: "exec_abc",
      session_id: "session-1",
      tool_call_id: "call-1",
      model: "test-model",
      diff: "--- a\n+++ b",
    });

    expect(record.executionId).toBe("exec_abc");
    expect(record.sessionId).toBe("session-1");
    expect(record.toolCallId).toBe("call-1");
    expect(record.model).toBe("test-model");
    expect(record.diff).toBe("--- a\n+++ b");
    // Legacy entries stay byte-compatible: no scheduled fields are written
    // unless the caller supplies them.
    expect("scheduled_task_id" in record).toBe(false);
    expect("scheduled_task_run_id" in record).toBe(false);
    expect("scheduled_task_attempt_id" in record).toBe(false);
  });

  it("persists optional scheduled task correlation fields when provided", async () => {
    const cwd = await workspace();
    const record = await provenanceRepository.record(cwd, {
      path: "digest/report.md",
      tool: "scheduled-task-service",
      execution_id: "exec_sched",
      scheduled_task_id: "task-1",
      scheduled_task_run_id: "run-7",
      scheduled_task_attempt_id: "attempt-2",
    });

    expect(record.scheduled_task_id).toBe("task-1");
    expect(record.scheduled_task_run_id).toBe("run-7");
    expect(record.scheduled_task_attempt_id).toBe("attempt-2");

    const persisted = (await ledger(cwd)).at(-1)!;
    expect(persisted).toMatchObject({ executionId: "exec_sched", scheduled_task_id: "task-1", scheduled_task_run_id: "run-7", scheduled_task_attempt_id: "attempt-2" });

    // Partial correlation is allowed and only writes supplied keys.
    const partial = await provenanceRepository.record(cwd, { path: "digest/report.md", scheduled_task_id: "task-1" });
    expect(partial.scheduled_task_id).toBe("task-1");
    expect("scheduled_task_attempt_id" in partial).toBe(false);
  });
});
