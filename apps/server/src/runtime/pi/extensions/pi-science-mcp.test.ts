import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectedServers } from "./pi-science-mcp.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi-Science MCP runtime extension", () => {
  it("resolves the managed snapshot from each session cwd", async () => {
    const root = join(tmpdir(), `pi-science-mcp-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await writeFile(join(workspace, ".pi-science", "mcp-runtime.json"), JSON.stringify({
      version: 1,
      project_id: "project_test",
      mcpServers: {
        "paper-search": { command: "node", args: ["server.js"], approveTools: true },
      },
    }), "utf8");
    expect(loadProjectedServers(workspace)["paper-search"]).toMatchObject({
      command: "node",
      args: ["server.js"],
      __piScienceProjectId: "project_test",
    });
    expect(loadProjectedServers(join(root, "empty-workspace"))).toEqual({});
  });
});
