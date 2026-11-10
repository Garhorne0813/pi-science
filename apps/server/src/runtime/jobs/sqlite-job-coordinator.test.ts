import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { JobRepository } from "../../storage/sqlite/repositories/job-repository.js";
import { WorkspaceRepository } from "../../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "../../storage/sqlite/state-store.js";
import { JobCoordinator } from "./job-coordinator.js";

const coordinators: JobCoordinator[] = [];
const stores: InMemorySqliteStateStore[] = [];
const directories: string[] = [];
beforeEach(() => vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host"));

afterEach(async () => {
  await Promise.allSettled(coordinators.splice(0).map((coordinator) => coordinator.shutdown()));
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

describe("SQLite-backed job coordination", () => {
  it("does not persist cancellation between spawn authorization and child registration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-sqlite-job-race-"));
    directories.push(cwd);
    const state = new InMemorySqliteStateStore();
    stores.push(state);
    await state.start();
    const repository = new JobRepository(state, new WorkspaceRepository(state));
    const environment = { environment: async () => ({ ...process.env }) };
    const executions = {
      start: async () => ({}),
      finish: async () => ({}),
    } as unknown as ConstructorParameters<typeof JobCoordinator>[2];
    let releaseSpawn!: () => void;
    let enteredSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const spawnEntered = new Promise<void>((resolve) => {
      enteredSpawn = resolve;
    });
    const owner = new JobCoordinator(
      environment,
      {
        testBeforeAuthorizedSpawn: async () => {
          enteredSpawn();
          await spawnGate;
        },
      },
      executions,
      repository,
    );
    const canceller = new JobCoordinator(environment, {}, executions, repository);
    coordinators.push(owner, canceller);

    const submitted = await owner.submit(cwd, {
      command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    });
    await spawnEntered;
    let cancellationSettled = false;
    const cancellation = canceller.cancel(cwd, submitted.job_id).finally(() => {
      cancellationSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(cancellationSettled).toBe(false);
    expect((await repository.get(cwd, submitted.job_id))?.status).toBe("running");

    releaseSpawn();
    expect((await cancellation)?.status).toBe("cancelled");
    expect((await repository.get(cwd, submitted.job_id))?.status).toBe("cancelled");
  }, 15_000);
});

it("reconciles a terminal SQLite job after projection failure and reopening storage", async () => {
  const { SqliteStateStore } = await import("../../storage/sqlite/state-store.js");
  const { ExecutionRepository } = await import("../executions/execution-repository.js");
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-job-projection-restart-"));
  directories.push(cwd);
  const path = join(cwd, "state.sqlite");
  const state = new SqliteStateStore({ path });
  await state.start();
  const executions = new ExecutionRepository();
  const failure = vi
    .spyOn(executions, "finish")
    .mockRejectedValue(new Error("injected projection failure"));
  const repository = new JobRepository(state);
  const owner = new JobCoordinator(
    { environment: async () => ({ ...process.env }) },
    {},
    executions,
    repository,
  );
  const log = vi.fn();
  owner.configureLogging(log);
  const submitted = await owner.submit(cwd, {
    command: [process.execPath, "-e", ""],
    idempotency_key: "durable-key",
  });
  await owner.shutdown();
  const durable = await repository.get(cwd, submitted.job_id);
  expect(["succeeded", "cancelled", "failed"]).toContain(durable?.status);
  expect(log).toHaveBeenCalled();
  expect((await executions.get(cwd, submitted.execution_id!))?.status).toBe("running");
  await state.close();
  failure.mockRestore();
  const reopened = new SqliteStateStore({ path });
  await reopened.start();
  const recovered = new JobCoordinator(
    { environment: async () => ({ ...process.env }) },
    {},
    new ExecutionRepository(),
    new JobRepository(reopened),
  );
  try {
    await recovered.startReconciliation(async () => [cwd]);
    expect((await executions.get(cwd, submitted.execution_id!))?.status).toBe(durable?.status);
    expect(
      (
        await recovered.submit(cwd, {
          command: [process.execPath, "-e", ""],
          idempotency_key: "durable-key",
        })
      ).job_id,
    ).toBe(submitted.job_id);
    expect(await executions.events(cwd)).toHaveLength(2);
  } finally {
    await recovered.shutdown();
    await reopened.close();
  }
});
