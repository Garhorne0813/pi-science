import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NodeSessionService } from "../runtime/node/node-session-service.js";
import { SettingsStore } from "../storage/settings-store.js";
import { registerCatalogRoutes } from "../http/routes/catalog-routes.js";
import { registerSettingsRoutes } from "../http/routes/settings-routes.js";
import { resolveMcpConfig } from "./mcp-config.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiScienceHome = process.env.PI_SCIENCE_HOME;
let home: string;
let piScienceHome: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-mcp-home-"));
  piScienceHome = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_SCIENCE_HOME = piScienceHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalPiScienceHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalPiScienceHome;
  await Promise.all([home, piScienceHome].map((path) => rm(path, { recursive: true, force: true })));
});

async function writeMcp(path: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: servers }), "utf8");
}

describe("MCP configuration resolution", () => {
  it("discovers the standard user-level MCP configuration", async () => {
    const standardPath = join(home, ".config", "mcp", "mcp.json");
    await writeMcp(standardPath, { "paper-search": { command: "python", args: ["-m", "paper_search_mcp.server"] } });

    await expect(resolveMcpConfig()).resolves.toEqual({
      definitions: { "paper-search": { command: "python", args: ["-m", "paper_search_mcp.server"] } },
      source: standardPath,
    });
  });

  it("does not read arbitrary explicit config paths outside standard locations", async () => {
    const workspace = join(home, "workspace");
    const explicitPath = join(home, "explicit-mcp.json");
    await writeMcp(join(home, ".config", "mcp", "mcp.json"), { standard: {} });
    await writeMcp(join(workspace, ".mcp.json"), { workspace: {} });
    await writeMcp(explicitPath, { explicit: {} });

    const result = await resolveMcpConfig({ workspaceRoot: workspace, explicitPath });
    expect(result).toEqual({ definitions: { workspace: {} }, source: join(await realpath(workspace), ".mcp.json") });
  });

  it("exposes standard user-level servers through the Settings endpoint", async () => {
    const standardPath = join(home, ".config", "mcp", "mcp.json");
    await writeMcp(standardPath, { "paper-search": { command: "python" } });
    await writeFile(join(piScienceHome, "config.json"), JSON.stringify({ mcp_servers: ["paper-search"] }), "utf8");
    const session = { reloadConfiguration: vi.fn().mockResolvedValue([]) } as unknown as NodeSessionService;
    const app = Fastify({ logger: false });
    registerSettingsRoutes(app, session, new SettingsStore());

    const response = await app.inject({ method: "GET", url: "/api/settings/mcp" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ servers: ["paper-search"], configured: ["paper-search"], config_path: standardPath });
    await app.close();
  });

  it("uses the same standard user-level configuration in the MCP Catalog", async () => {
    const standardPath = join(home, ".config", "mcp", "mcp.json");
    const workspace = join(home, "workspace");
    await writeMcp(standardPath, { "paper-search": { command: "python" } });
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await writeFile(join(piScienceHome, "config.json"), JSON.stringify({ mcp_servers: ["paper-search"] }), "utf8");
    const app = Fastify({ logger: false });
    registerCatalogRoutes(app);

    const response = await app.inject({ method: "GET", url: `/api/mcp/catalog?cwd=${encodeURIComponent(workspace)}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ config_path: standardPath, servers: [{ id: "paper-search", enabled: true }] });
    await app.close();
  });
});
