import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerCatalogRoutes } from "./catalog-routes.js";

const originalHome = process.env.PI_SCIENCE_HOME;
let home: string;
let wsSeq = 0;
const cleanups: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-catalog-content-"));
  cleanups.push(home);
  process.env.PI_SCIENCE_HOME = home;
  wsSeq = 0;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspaceWithProjectSkill(name: string, content: string): Promise<string> {
  const cwd = join(home, `ws-${++wsSeq}`);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  await mkdir(join(cwd, ".pi", "skills", name), { recursive: true });
  await writeFile(join(cwd, ".pi", "skills", name, "SKILL.md"), content, "utf8");
  return cwd;
}

const SKILL = (name: string, body = "## Steps\n\n1. Do the thing.") =>
  `---\nname: ${name}\ndescription: Fixture skill\nlicense: MIT\n---\n${body}\n`;

describe("GET /api/skills/:skill_id/content", () => {
  it("returns the effective project SKILL.md with a relative location", async () => {
    const cwd = await workspaceWithProjectSkill("alpha", SKILL("alpha", "## Steps\n\nRun it."));
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/alpha/content?cwd=${encodeURIComponent(cwd)}` });
    await app.close();
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ name: "alpha", source: "project", location: ".pi/skills/alpha/SKILL.md" });
    expect(String(body.content)).toContain("Run it.");
    expect(String(body.digest)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns 404 for an unknown skill", async () => {
    const cwd = await workspaceWithProjectSkill("alpha", SKILL("alpha"));
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/nope/content?cwd=${encodeURIComponent(cwd)}` });
    await app.close();
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when the skill exists in another workspace only", async () => {
    await workspaceWithProjectSkill("alpha", SKILL("alpha"));
    const cwd = join(home, `ws-${++wsSeq}`);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/alpha/content?cwd=${encodeURIComponent(cwd)}` });
    await app.close();
    expect(response.statusCode).toBe(404);
  });

  it.skipIf(process.platform === "win32")("returns 403 for a SKILL.md symlink escaping the source root", async () => {
    const cwd = await workspaceWithProjectSkill("alpha", SKILL("alpha"));
    const outside = join(home, "outside.txt");
    await writeFile(outside, "secret", "utf8");
    await rm(join(cwd, ".pi", "skills", "alpha", "SKILL.md"));
    await symlink(outside, join(cwd, ".pi", "skills", "alpha", "SKILL.md"));
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/alpha/content?cwd=${encodeURIComponent(cwd)}` });
    await app.close();
    expect(response.statusCode).toBe(403);
  });

  it("returns 413 for a SKILL.md above the size cap", async () => {
    const cwd = await workspaceWithProjectSkill("huge", "");
    await writeFile(join(cwd, ".pi", "skills", "huge", "SKILL.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/huge/content?cwd=${encodeURIComponent(cwd)}` });
    await app.close();
    expect(response.statusCode).toBe(413);
  });

  it("rejects crafted skill ids with path separators", async () => {
    const cwd = await workspaceWithProjectSkill("alpha", SKILL("alpha"));
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/${encodeURIComponent("../secret")}/content?cwd=${encodeURIComponent(cwd)}` });
    await app.close();
    expect(response.statusCode).toBe(404);
  });

  it("scopes content to the requested workspace", async () => {
    await workspaceWithProjectSkill("alpha", SKILL("alpha", "WORKSPACE A BODY"));
    await workspaceWithProjectSkill("beta", SKILL("beta", "WORKSPACE B BODY"));
    const cwdB = join(home, `ws-${wsSeq}`);
    const app = Fastify();
    registerCatalogRoutes(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/alpha/content?cwd=${encodeURIComponent(cwdB)}` });
    await app.close();
    expect(response.statusCode).toBe(404);
  });
});
