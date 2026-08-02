import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProject, projectManifestPath, readProject, updateProject } from "./project-registry.js";

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-science-project-registry-"));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project registry", () => {
  it("creates a colocated manifest with a stable identity", async () => {
    const cwd = await workspace();

    const first = await ensureProject(cwd, "Molecular Playground");
    const second = await ensureProject(cwd, "A different display name");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      id: expect.stringMatching(/^project_/),
      name: "Molecular Playground",
      version: 1,
    });
    expect(JSON.parse(await readFile(projectManifestPath(cwd), "utf8"))).toEqual(first);
    await expect(readProject(cwd)).resolves.toEqual(first);
  });

  it("serializes concurrent registration and never allocates two project ids", async () => {
    const cwd = await workspace();
    const projects = await Promise.all(Array.from({ length: 8 }, () => ensureProject(cwd)));

    expect(new Set(projects.map((project) => project.id)).size).toBe(1);
  });

  it("updates display metadata without changing the project id", async () => {
    const cwd = await workspace();
    const original = await ensureProject(cwd, "Before rename");
    const renamed = await updateProject(cwd, { name: "After rename" });

    expect(renamed).toMatchObject({ id: original.id, name: "After rename", version: 1 });
    expect(renamed.created_at).toBe(original.created_at);
    await expect(readProject(cwd)).resolves.toEqual(renamed);
  });

  it("fails closed on a malformed existing manifest", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(projectManifestPath(cwd), "{ not valid json\n", "utf8");

    await expect(ensureProject(cwd)).rejects.toThrow(/Invalid project manifest JSON/);
  });
});
