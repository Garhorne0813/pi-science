import { resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { catalogToolCommands, expandUserPath, registerCatalogRoutes } from "./catalog-routes.js";
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
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
