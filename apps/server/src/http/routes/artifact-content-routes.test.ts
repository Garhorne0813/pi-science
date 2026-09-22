import Fastify from "fastify";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerArtifactRoutes } from "./artifact-routes.js";

const apps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("immutable artifact content", () => {
  it("serves the published bytes for an older SHA after the workspace path advances", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-content-"));
    workspaces.push(cwd);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(join(cwd, "result.txt"), "version-one", "utf8");

    const app = Fastify({ logger: false });
    registerArtifactRoutes(app);
    apps.push(app);

    const first = await app.inject({
      method: "POST",
      url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`,
      payload: { path: "result.txt", tool: "test" },
    });
    expect(first.statusCode).toBe(200);
    const firstArtifact = first.json() as { sha256: string; version: number };
    expect(firstArtifact.version).toBe(1);

    await writeFile(join(cwd, "result.txt"), "version-two", "utf8");
    const second = await app.inject({
      method: "POST",
      url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`,
      payload: { path: "result.txt", tool: "test" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ version: 2 });

    const oldRead = await app.inject({
      method: "GET",
      url: `/api/artifacts/content/${firstArtifact.sha256}?cwd=${encodeURIComponent(cwd)}&path=result.txt&maxBytes=8192`,
    });
    expect(oldRead.statusCode).toBe(200);
    expect(oldRead.json()).toMatchObject({ path: "result.txt", data: "version-one", encoding: "utf8" });

    const oldServe = await app.inject({
      method: "GET",
      url: `/api/artifacts/content/${firstArtifact.sha256}/serve?cwd=${encodeURIComponent(cwd)}&path=result.txt`,
    });
    expect(oldServe.statusCode).toBe(200);
    expect(oldServe.body).toBe("version-one");
  });
});
