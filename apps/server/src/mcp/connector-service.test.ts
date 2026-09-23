import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpRepository } from "../storage/sqlite/repositories/mcp-repository.js";
import { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import { InMemorySqliteStateStore } from "../storage/sqlite/state-store.js";
import { McpConnectorService } from "./connector-service.js";
import { McpRuntimeProjection } from "./runtime-projection.js";

const stores: InMemorySqliteStateStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MCP connector startup materialization", () => {
  it("marks a known workspace whose directory is gone instead of failing startup", async () => {
    const alive = await mkdtemp(join(tmpdir(), "pi-science-mcp-alive-"));
    const removed = await mkdtemp(join(tmpdir(), "pi-science-mcp-removed-"));
    directories.push(alive, removed);
    const state = new InMemorySqliteStateStore();
    stores.push(state);
    await state.start();
    const workspaces = new WorkspaceRepository(state);
    const repository = new McpRepository(state);
    const service = new McpConnectorService(
      repository,
      workspaces,
      {} as unknown as ConstructorParameters<typeof McpConnectorService>[2],
      undefined,
      new McpRuntimeProjection(repository),
    );

    await workspaces.rememberWorkspace(alive);
    await workspaces.rememberWorkspace(removed);
    const removedPath = await realpath(removed);
    // The registration outlives the directory, exactly as a deleted workspace
    // folder or a finished UAT run leaves it. Materializing it used to reject
    // the whole startup on the realpath inside validateWorkspaceCwd.
    await rm(removed, { recursive: true, force: true });

    await expect(service.ensureBuiltins()).resolves.toBeUndefined();

    const paths = (await workspaces.listKnown({ includeMissing: false })).map((location) => location.path);
    expect(paths).toContain(await realpath(alive));
    expect(paths).not.toContain(removedPath);
    const stale = (await workspaces.listKnown()).find((location) => location.path === removedPath);
    expect(stale?.missing_since).toBeTruthy();
  });
});
