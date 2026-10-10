import { resolve } from "node:path";
import { mkdtemp, mkdir, opendir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { catalogToolCommands, expandUserPath, registerCatalogRoutes } from "./catalog-routes.js";
import { ensureProject } from "../../project/project-registry.js";
import { sessionRepository } from "../../runtime/node/session-repository.js";
import { userHome } from "../../support/platform-utils.js";

describe("catalog route platform defaults", () => {
  it("expands a bare tilde to the user home directory", () => {
    expect(expandUserPath("~")).toBe(resolve(userHome()));
  });

  it("probes the Windows Python command without relying on cached host status", () => {
    expect(catalogToolCommands({}, "win32")[0]).toEqual(["python", "python"]);
    expect(catalogToolCommands({}, "linux")[0]).toEqual(["python", "python3"]);
    expect(catalogToolCommands({ PYTHON: "py-custom" }, "win32")[0]).toEqual(["python", "py-custom"]);
  });
});

const originalHome = process.env.PI_SCIENCE_HOME;
let home: string;
const cleanups: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-catalog-routes-"));
  cleanups.push(home);
  process.env.PI_SCIENCE_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
}, 30_000);

async function workspaceWithMcp(servers: Record<string, unknown>): Promise<string> {
  const cwd = join(home, `ws-${cleanups.length}`);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
  return cwd;
}

async function workspaceWithSkill(requirements: unknown[]): Promise<string> {
  const cwd = join(home, `ws-${cleanups.length}`);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  await mkdir(join(cwd, ".pi", "skills", "probe-skill"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "skills", "probe-skill", "SKILL.md"),
    `---\nname: probe-skill\ndescription: "Skill used by the readiness route tests"\nversion: 0.1.0\nlicense: MIT\nrequirements:\n${requirements.map((item) => `  - ${JSON.stringify(item)}`).join("\n") || "  []"}\n---\n`,
    "utf8",
  );
  return cwd;
}

describe("MCP health and egress routes", () => {
  it("reports a missing stdio command with a clear reason", async () => {
    const cwd = await workspaceWithMcp({ "stdio-tool": { command: "no-such-binary-xyz" } });
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/mcp/health/stdio-tool?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.health).toBe("error");
    expect(String(body.error)).toContain("command not found");
    expect(typeof body.checked_at).toBe("number");
    await app.close();
  });

  it("reports an http server URL that resolves into a private range", async () => {
    const cwd = await workspaceWithMcp({ "http-api": { url: "http://127.0.0.1:9999/" } });
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/mcp/health/http-api?cwd=${encodeURIComponent(cwd)}` });
    const body = response.json() as Record<string, unknown>;
    expect(body.health).toBe("error");
    expect(String(body.error)).toContain("private or reserved");
    await app.close();
  });

  it("keeps a disabled server blocked with its previous shape", async () => {
    const cwd = await workspaceWithMcp({ "stdio-tool": { command: "no-such-binary-xyz" } });
    await writeFile(join(home, "config.json"), JSON.stringify({ mcp_servers: [] }), "utf8");
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/mcp/health/stdio-tool?cwd=${encodeURIComponent(cwd)}` });
    const body = response.json() as Record<string, unknown>;
    expect(body.health).toBe("blocked");
    expect(body.error).toBe("server disabled");
    await app.close();
  });

  it("returns 404 for unknown servers", async () => {
    const cwd = await workspaceWithMcp({});
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/mcp/health/nope?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
  it("records an egress audit entry for remote servers and reports the audit switch", async () => {
    const cwd = await workspaceWithMcp({ "http-api": { url: "https://eutils.ncbi.nlm.nih.gov/" } });
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/mcp/egress/http-api?cwd=${encodeURIComponent(cwd)}` });
    const body = response.json() as Record<string, unknown>;
    expect(body.audit_enabled).toBe(true);
    expect(body.warning).toContain("Review the destination");
    const lines = (await readFile(join(home, "egress-audit.jsonl"), "utf8")).trim().split("\n");
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.connector_id).toBe("http-api");
    expect(entry.target_domain).toBe("eutils.ncbi.nlm.nih.gov");
    expect(entry.approved).toBe(false);
    await app.close();
  });

  it("does not audit local stdio servers", async () => {
    const cwd = await workspaceWithMcp({ "stdio-tool": { command: "node" } });
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/mcp/egress/stdio-tool?cwd=${encodeURIComponent(cwd)}` });
    expect((response.json() as Record<string, unknown>).audit_enabled).toBe(true);
    await expect(readFile(join(home, "egress-audit.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });
});

describe("skill readiness route", () => {
  it("reports blocked when a required command is missing", async () => {
    const cwd = await workspaceWithSkill([{ name: "no-such-binary-xyz", kind: "command" }]);
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/probe-skill/readiness?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.ready).toBe(false);
    expect(body.skill_id).toBeTypeOf("string");
    const probes = body.requirements as Array<Record<string, unknown>>;
    expect(probes[0]).toMatchObject({ name: "no-such-binary-xyz", status: "missing" });
    expect(String(probes[0]?.reason)).toContain("not found on PATH");
    await app.close();
  });

  it("reports ready for a present required command", async () => {
    const cwd = await workspaceWithSkill([{ name: "node", kind: "command" }]);
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/probe-skill/readiness?cwd=${encodeURIComponent(cwd)}` });
    const body = response.json() as Record<string, unknown>;
    expect(body.ready).toBe(true);
    expect((body.requirements as Array<Record<string, unknown>>)[0]).toMatchObject({ status: "ready" });
    await app.close();
  });

  it("does not block on missing optional requirements", async () => {
    const cwd = await workspaceWithSkill([{ name: "no-such-binary-xyz", kind: "command", optional: true }]);
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/probe-skill/readiness?cwd=${encodeURIComponent(cwd)}` });
    const body = response.json() as Record<string, unknown>;
    expect(body.ready).toBe(true);
    expect((body.requirements as Array<Record<string, unknown>>)[0]).toMatchObject({ status: "missing-optional" });
    await app.close();
  });

  it("returns 404 for an unknown skill", async () => {
    const cwd = await workspaceWithSkill([]);
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/no-such-skill/readiness?cwd=${encodeURIComponent(cwd)}` });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, opendir: vi.fn(original.opendir) };
});

describe("workspace activity", () => {
  it.each([false, true])("keeps the whole project list available when a background scan encounters EIO (reverse registration: %s)", async (reverseRegistration) => {
    const app = Fastify();
    const warn = vi.spyOn(app.log, "warn");
    registerCatalogRoutes(app);
    const paths = [join(home, "broken-workspace"), join(home, "healthy-workspace")];
    for (const path of paths) {
      await mkdir(path);
      await ensureProject(path);
      // Node rounds Stats.mtime, while new Date(mtimeMs) truncates fractional ms.
      await utimes(path, 1000.1239, 1000.1239);
    }
    await writeFile(join(home, "registered-workspaces.json"), JSON.stringify(reverseRegistration ? [...paths].reverse() : paths));
    const error = Object.assign(new Error("Disk unavailable"), { code: "EIO" });
    const openDirectory = vi.mocked(opendir).getMockImplementation()!;
    // Workspace preparation is concurrent; inject by identity, not call order.
    vi.mocked(opendir).mockImplementation((path, options) => String(path) === paths[0]
      ? Promise.reject(error)
      : openDirectory(path, options));
    try {
      const response = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(2);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith({ err: error, workspace: paths[0] }, expect.any(String)));
      const refreshed = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toHaveLength(2);
      expect(refreshed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ path: paths[0], last_activity_at: (await stat(paths[0]!)).mtime.toISOString() })]));
    } finally { vi.mocked(opendir).mockRestore(); warn.mockRestore(); await app.close(); }
  });
  it("includes nested file activity and relocated session activity without changing last_modified", async () => {
    const app = Fastify();
    registerCatalogRoutes(app);
    const cwd = join(home, "activity-workspace");
    await mkdir(join(cwd, "research"), { recursive: true });
    const file = join(cwd, "research", "notes.md");
    await writeFile(file, "initial");
    await writeFile(join(home, "registered-workspaces.json"), JSON.stringify([cwd]));
    // Initialize project metadata before freezing directory mtimes.
    await ensureProject(cwd);
    const external = join(home, "external");
    await mkdir(external);
    await writeFile(join(external, "unrelated.md"), "not this workspace");
    await symlink(external, join(cwd, "linked"), "dir");
    await mkdir(join(cwd, "node_modules"));
    await writeFile(join(cwd, "node_modules", "dependency.js"), "dependency");
    const old = new Date("2026-09-01T00:00:00Z");
    await utimes(file, old, old);
    await utimes(join(cwd, "research"), old, old);
    await utimes(cwd, old, old);
    const rootTime = (await stat(cwd)).mtime.toISOString();
    const recent = new Date("2026-09-15T00:00:00Z");
    await writeFile(file, "continued research");
    await utimes(file, recent, recent);
    const sessions = vi.spyOn(sessionRepository, "list").mockResolvedValue([]);
    try {
      const response = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([expect.objectContaining({ last_modified: rootTime, last_activity_at: rootTime })]);
      await vi.waitFor(async () => {
        const refreshed = await app.inject({ method: "GET", url: "/api/workspaces" });
        expect(refreshed.json()).toEqual([expect.objectContaining({ last_modified: rootTime, last_activity_at: recent.toISOString() })]);
      });
      sessions.mockResolvedValue([{ id: "s1", cwd, project_id: null, name: null, created_at: old.toISOString(), updated_at: "2026-09-20T00:00:00Z" }]);
      const updated = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(updated.json()).toEqual([expect.objectContaining({ last_modified: rootTime, last_activity_at: "2026-09-20T00:00:00.000Z", session_count: 1 })]);
    } finally { sessions.mockRestore(); await app.close(); }
  });
});
