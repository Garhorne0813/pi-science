import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { diffKindFor } from "../../runtime/artifacts/artifact-diff.js";

const apps: FastifyInstance[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-diff-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

async function publish(cwd: string, path: string): Promise<{ artifact_id: string; version: number; sha256: string }> {
  const app = apps[0]!;
  const response = await app.inject({
    method: "POST",
    url: `/api/artifacts/publish?cwd=${encodeURIComponent(cwd)}`,
    payload: { path, tool: "test" },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { artifact_id: string; version: number; sha256: string };
}

async function setup(): Promise<{ cwd: string }> {
  const cwd = await makeWorkspace();
  const app = Fastify({ logger: false });
  registerArtifactRoutes(app);
  apps.push(app);
  return { cwd };
}

describe("diffKindFor", () => {
  it("classifies text, tables and images", () => {
    expect(diffKindFor({ artifact_id: "a", version: 1, path: "notes/report.md", mime: "text/markdown", sha256: "x" })).toBe("text");
    expect(diffKindFor({ artifact_id: "a", version: 1, path: "data/table.csv", mime: "text/csv", sha256: "x" })).toBe("table");
    expect(diffKindFor({ artifact_id: "a", version: 1, path: "fig/plot.png", mime: "image/png", sha256: "x" })).toBe("image");
    expect(diffKindFor({ artifact_id: "a", version: 1, path: "bin/model.pt", mime: "application/octet-stream", sha256: "x" })).toBe("unsupported");
  });
});

describe("GET /api/artifacts/:artifact_id/diff", () => {
  it("diffs two text versions into unified hunks", async () => {
    const { cwd } = await setup();
    await writeFile(join(cwd, "report.md"), "intro\nmethod one\nresults\n", "utf8");
    const first = await publish(cwd, "report.md");
    await writeFile(join(cwd, "report.md"), "intro\nmethod two\nresults\nconclusion\n", "utf8");
    const second = await publish(cwd, "report.md");

    const response = await apps[0]!.inject({
      method: "GET",
      url: `/api/artifacts/${second.artifact_id}/diff?cwd=${encodeURIComponent(cwd)}&from=${first.version}&to=${second.version}`,
    });
    expect(response.statusCode).toBe(200);
    const diff = response.json() as { kind: string; hunks: Array<{ header: string; lines: Array<{ type: string; text: string }> }> };
    expect(diff.kind).toBe("text");
    expect(diff.hunks[0]!.lines).toEqual(expect.arrayContaining([
      { type: "-", text: "method one" },
      { type: "+", text: "method two" },
      { type: "+", text: "conclusion" },
    ]));
    expect(diff.hunks[0]!.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  it("diffs csv versions cell by cell", async () => {
    const { cwd } = await setup();
    await writeFile(join(cwd, "metrics.csv"), "epoch,loss,acc\n1,0.5,0.7\n2,0.4,0.8\n", "utf8");
    await publish(cwd, "metrics.csv");
    await writeFile(join(cwd, "metrics.csv"), "epoch,loss,acc\n1,0.5,0.75\n2,0.4,0.8\n3,0.3,0.9\n", "utf8");
    const second = await publish(cwd, "metrics.csv");

    const response = await apps[0]!.inject({
      method: "GET",
      url: `/api/artifacts/${second.artifact_id}/diff?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(response.statusCode).toBe(200);
    const diff = response.json() as { kind: string; cells: Array<{ row: number; column: string; from: string; to: string }>; rows_added: number; rows_removed: number };
    expect(diff.kind).toBe("table");
    expect(diff.cells).toEqual([{ row: 2, column: "acc", from: "0.7", to: "0.75" }]);
    expect(diff.rows_added).toBe(1);
    expect(diff.rows_removed).toBe(0);
  });

  it("returns paired content hashes for images", async () => {
    const { cwd } = await setup();
    await writeFile(join(cwd, "plot.png"), Buffer.from([1, 2, 3]), "utf8");
    const first = await publish(cwd, "plot.png");
    await writeFile(join(cwd, "plot.png"), Buffer.from([4, 5, 6]), "utf8");
    const second = await publish(cwd, "plot.png");

    const response = await apps[0]!.inject({
      method: "GET",
      url: `/api/artifacts/${second.artifact_id}/diff?cwd=${encodeURIComponent(cwd)}&from=${first.version}&to=${second.version}`,
    });
    expect(response.statusCode).toBe(200);
    const diff = response.json() as { kind: string; from_sha256: string; to_sha256: string };
    expect(diff.kind).toBe("image");
    expect(diff.from_sha256).toBe(first.sha256);
    expect(diff.to_sha256).toBe(second.sha256);
  });

  it("reports unsupported kinds instead of guessing", async () => {
    const { cwd } = await setup();
    await writeFile(join(cwd, "model.bin"), Buffer.from([1, 2, 3]), "utf8");
    await publish(cwd, "model.bin");
    await writeFile(join(cwd, "model.bin"), Buffer.from([4, 5, 6]), "utf8");
    const second = await publish(cwd, "model.bin");

    const response = await apps[0]!.inject({
      method: "GET",
      url: `/api/artifacts/${second.artifact_id}/diff?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "unsupported" });
  });
});

describe("GET /api/artifacts/by-path/*", () => {
  it("resolves the latest published version for a path", async () => {
    const { cwd } = await setup();
    await mkdir(join(cwd, "figures"), { recursive: true });
    await writeFile(join(cwd, "figures/plot.png"), Buffer.from([1]), "utf8");
    await publish(cwd, "figures/plot.png");
    await writeFile(join(cwd, "figures/plot.png"), Buffer.from([2]), "utf8");
    const second = await publish(cwd, "figures/plot.png");

    const response = await apps[0]!.inject({
      method: "GET",
      url: `/api/artifacts/by-path/figures/plot.png?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ artifact_id: second.artifact_id, version: 2, sha256: second.sha256 });

    const pinned = await apps[0]!.inject({
      method: "GET",
      url: `/api/artifacts/by-path/figures/plot.png?cwd=${encodeURIComponent(cwd)}&version=1`,
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ version: 1 });
  });

  it("404s for paths that were never published", async () => {
    const { cwd } = await setup();
    const response = await apps[0]!.inject({
      method: "GET",
      url: `/api/artifacts/by-path/never/published.txt?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
