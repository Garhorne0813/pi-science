import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectedServers } from "./pi-science-mcp.js";
import { CredentialStore } from "../../../model-resources/credential-store.js";

const cleanup: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
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

  it("materializes credential references only inside the Pi process", async () => {
    const root = join(tmpdir(), `pi-science-mcp-credential-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(root);
    process.env.PI_SCIENCE_HOME = join(root, "control-home");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await new CredentialStore().put({ id: "mcp_test", kind: "api_key", backend: "managed", secret: "runtime-only-token", owner_kind: "mcp", owner_id: "test" });
    const snapshot = JSON.stringify({ version: 1, project_id: "project_test", mcpServers: { remote: { url: "https://example.com/mcp", __piScienceHeaders: { Authorization: { kind: "credential", credential_ref: "mcp_test", prefix: "Bearer " } } } } });
    await writeFile(join(workspace, ".pi-science", "mcp-runtime.json"), snapshot, "utf8");
    expect(snapshot).not.toContain("runtime-only-token");
    expect(loadProjectedServers(workspace).remote?.headers).toEqual({ Authorization: "Bearer runtime-only-token" });
  });
});
