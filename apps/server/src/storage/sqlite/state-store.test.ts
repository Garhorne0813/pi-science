import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobRecord } from "../../runtime/jobs/job-coordinator.js";
import { JobRepository } from "./repositories/job-repository.js";
import { WorkspaceRepository } from "./repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "./state-store.js";

const stores: InMemorySqliteStateStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function store(): Promise<InMemorySqliteStateStore> {
  const value = new InMemorySqliteStateStore();
  stores.push(value);
  await value.start();
  return value;
}

function completedJob(cwd: string): JobRecord {
  return {
    job_id: "job_1234567890abcdef",
    command: [process.execPath, "-e", "process.exit(0)"],
    cwd,
    surface: "local",
    status: "succeeded",
    created_at: new Date(1_000).toISOString(),
    started_at: new Date(1_100).toISOString(),
    ended_at: new Date(1_200).toISOString(),
    return_code: 0,
    stdout: "",
    stderr: "",
    artifact_ids: [],
    environment: {},
    requirement: {},
  };
}

describe("SQLite state store", () => {
  it("starts the worker, applies migrations, and rolls back a failed batch", async () => {
    const state = await store();
    expect(state.diagnostics()).toMatchObject({ status: "ready", schema_version: 1 });

    await expect(state.batch([
      { sql: "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, 1, 1, 1)", params: ["project-one", "one"] },
      { sql: "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, 1, 1, 1)", params: ["project-one", "duplicate"] },
    ])).rejects.toThrow();

    expect(await state.get<{ count: number }>("SELECT COUNT(*) AS count FROM projects")).toEqual({ count: 0 });
  });

  it("keeps job history attached to project identity after a workspace rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-sqlite-rename-"));
    directories.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    const state = await store();
    const workspaces = new WorkspaceRepository(state);
    const jobs = new JobRepository(state, workspaces);

    const saved = await jobs.save(completedJob(source));
    const projectId = (await workspaces.getByPath(source))!.project_id;
    await rename(source, destination);
    await workspaces.moveLocation(projectId, source, destination, true);

    expect(await jobs.list(destination, 10)).toEqual([
      expect.objectContaining({ job_id: saved.job_id, cwd: resolve(destination) }),
    ]);

    await mkdir(source);
    await workspaces.rememberWorkspace(source);
    expect(await jobs.list(source, 10)).toEqual([]);
  });
});
