import { copyFile, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobRecord } from "../../runtime/jobs/job-coordinator.js";
import { JobRepository } from "./repositories/job-repository.js";
import { fingerprintPaths, WorkspaceRepository } from "./repositories/workspace-repository.js";
import { loadMigrations } from "./migrations.js";
import { InMemorySqliteStateStore, SqliteStateStore } from "./state-store.js";

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

function runningJob(cwd: string): JobRecord {
  return {
    job_id: "job_fedcba0987654321",
    command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    cwd,
    surface: "local",
    status: "running",
    created_at: new Date(2_000).toISOString(),
    started_at: new Date(2_100).toISOString(),
    return_code: null,
    stdout: "source-only",
    stderr: "",
    artifact_ids: [],
    environment: {},
    requirement: {},
  };
}

describe("SQLite state store", () => {
  it("starts the worker, applies migrations, and rolls back a failed batch", async () => {
    const state = await store();
    expect(state.diagnostics()).toMatchObject({ status: "ready", schema_version: 3 });

    await expect(state.batch([
      { sql: "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, 1, 1, 1)", params: ["project-one", "one"] },
      { sql: "INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, 1, 1, 1)", params: ["project-one", "duplicate"] },
    ])).rejects.toThrow();

    expect(await state.get<{ count: number }>("SELECT COUNT(*) AS count FROM projects")).toEqual({ count: 0 });
  });

  it("migrates project MCP bindings and tool grants into global connector settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-mcp-global-migration-"));
    directories.push(root);
    const path = join(root, "state.sqlite");
    const migrations = await loadMigrations();
    const legacy = new SqliteStateStore({ path, migrations: migrations.slice(0, 2) });
    await legacy.start();
    await legacy.run("INSERT INTO projects (project_id, name, manifest_version, created_at, updated_at, last_seen_at) VALUES ('project-1', 'one', 1, 1, 1, 1)");
    await legacy.run(
      `INSERT INTO mcp_connectors (connector_id, name, display_name, description, source, transport, endpoint_url, command, args_json, socket_path, runtime_config_json, credential_ref, revision, created_at, updated_at)
       VALUES ('mcp-1', 'papers', 'Papers', '', 'custom', 'stdio', NULL, 'node', '[]', NULL, '{"lifecycle":"lazy","expose_resources":true,"include_tools":[],"exclude_tools":[],"environment":{},"headers":{},"auth":"none","allow_private":false}', NULL, 1, 1, 1)`,
    );
    await legacy.run("INSERT INTO mcp_project_bindings (project_id, connector_id, enabled, include_tools_json, exclude_tools_json, approval_mode, revision, created_at, updated_at) VALUES ('project-1', 'mcp-1', 1, '[\"search\"]', '[]', 'custom', 1, 1, 2)");
    await legacy.run("INSERT INTO mcp_tool_grants (project_id, connector_id, tool_name, decision, updated_at) VALUES ('project-1', 'mcp-1', 'search', 'allow', 3)");
    await legacy.close();

    const upgraded = new SqliteStateStore({ path });
    await upgraded.start();
    expect(await upgraded.get("SELECT enabled, include_tools_json, approval_mode FROM mcp_connectors WHERE connector_id = 'mcp-1'"))
      .toEqual({ enabled: 1, include_tools_json: '["search"]', approval_mode: "custom" });
    expect(await upgraded.get("SELECT decision FROM mcp_global_tool_grants WHERE connector_id = 'mcp-1' AND tool_name = 'search'"))
      .toEqual({ decision: "allow" });
    expect(await upgraded.get<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('mcp_project_bindings', 'mcp_tool_grants')"))
      .toEqual({ count: 0 });
    await upgraded.close();
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
    const sourceLocation = (await workspaces.getByPath(source))!;
    const projectId = sourceLocation.project_id;
    await rename(source, destination);
    const canonicalDestination = await realpath(destination);
    await workspaces.moveLocation(projectId, sourceLocation.path, canonicalDestination, true);

    expect(await jobs.list(destination, 10)).toEqual([
      expect.objectContaining({ job_id: saved.job_id, cwd: canonicalDestination }),
    ]);

    await mkdir(source);
    await workspaces.rememberWorkspace(source);
    expect(await jobs.list(source, 10)).toEqual([]);
  });

  it("keeps jobs isolated when a workspace is copied with the same project manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-sqlite-copy-"));
    directories.push(root);
    const source = join(root, "source");
    const copy = join(root, "copy");
    await mkdir(source);
    await mkdir(join(copy, ".pi-science"), { recursive: true });
    const state = await store();
    const workspaces = new WorkspaceRepository(state);
    const jobs = new JobRepository(state, workspaces);

    const saved = await jobs.save(runningJob(source));
    await copyFile(join(source, ".pi-science", "project.json"), join(copy, ".pi-science", "project.json"));
    await workspaces.rememberWorkspace(copy);

    expect(await jobs.list(copy, 10)).toEqual([]);
    expect(await jobs.get(copy, saved.job_id)).toBeNull();
    expect(await jobs.cancel(copy, saved.job_id, Date.now())).toBeNull();
    expect((await jobs.get(source, saved.job_id))?.status).toBe("running");
  });

  it("reconciles pins removed from a changed legacy source", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-sqlite-pins-"));
    directories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    const state = await store();
    const workspaces = new WorkspaceRepository(state);
    const managedFingerprint = fingerprintPaths([]);

    await workspaces.importLegacy({
      registered_paths: [canonicalWorkspace],
      pinned_paths: [canonicalWorkspace],
      managed_paths: [],
      registered_fingerprint: "registered-v1",
      pinned_fingerprint: "pinned-v1",
      managed_fingerprint: managedFingerprint,
    });
    expect((await workspaces.listPinned()).map((location) => location.path)).toEqual([canonicalWorkspace]);

    await workspaces.importLegacy({
      registered_paths: [canonicalWorkspace],
      pinned_paths: [],
      managed_paths: [],
      registered_fingerprint: "registered-v1",
      pinned_fingerprint: "pinned-v2",
      managed_fingerprint: managedFingerprint,
    });
    expect(await workspaces.listPinned()).toEqual([]);
  });
});
