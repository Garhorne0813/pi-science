import { access, mkdtemp, readFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProject, projectManifestPath, readProject, updateProject } from "./project-registry.js";
import { legacyMetadataRoot, metadataRoot, workspaceStateRoot } from "../storage/persistence.js";

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
  it("creates a global manifest with a stable identity", async () => {
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
    await expect(access(legacyMetadataRoot(cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent registration and never allocates two project ids", async () => {
    const cwd = await workspace();
    const projects = await Promise.all(Array.from({ length: 8 }, () => ensureProject(cwd)));

    expect(new Set(projects.map((project) => project.id)).size).toBe(1);
  });

  it.skipIf(process.platform === "win32")("uses one state directory for symlink aliases of a workspace", async () => {
    const cwd = await workspace();
    const alias = `${cwd}-alias`;
    tempDirs.push(alias);
    await symlink(cwd, alias, "dir");

    expect(workspaceStateRoot(alias)).toBe(workspaceStateRoot(cwd));
    await expect(ensureProject(alias)).resolves.toEqual(await ensureProject(cwd));
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
    await mkdir(metadataRoot(cwd), { recursive: true });
    await writeFile(projectManifestPath(cwd), "{ not valid json\n", "utf8");

    await expect(ensureProject(cwd)).rejects.toThrow(/Invalid project manifest JSON/);
  });

  it("moves legacy workspace metadata into the global state root on first registration", async () => {
    const cwd = await workspace();
    const legacy = legacyMetadataRoot(cwd);
    await mkdir(join(legacy, "sessions"), { recursive: true });
    await writeFile(join(legacy, "sessions", "session-a.jsonl"), "legacy session\n", "utf8");
    const manifest = {
      id: "project_legacy",
      name: "Legacy project",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(join(legacy, "project.json"), JSON.stringify(manifest), "utf8");

    await expect(ensureProject(cwd)).resolves.toEqual(manifest);
    await expect(readFile(join(metadataRoot(cwd), "sessions", "session-a.jsonl"), "utf8")).resolves.toBe("legacy session\n");
    await expect(access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps both copies and fails closed when legacy and global state conflict", async () => {
    const cwd = await workspace();
    const legacy = legacyMetadataRoot(cwd);
    await mkdir(legacy, { recursive: true });
    await mkdir(metadataRoot(cwd), { recursive: true });
    await writeFile(join(legacy, "legacy.txt"), "legacy", "utf8");
    await writeFile(join(metadataRoot(cwd), "global.txt"), "global", "utf8");

    await expect(ensureProject(cwd)).rejects.toThrow(/global state directory is not empty/);
    await expect(readFile(join(legacy, "legacy.txt"), "utf8")).resolves.toBe("legacy");
    await expect(readFile(join(metadataRoot(cwd), "global.txt"), "utf8")).resolves.toBe("global");
  });

  it.skipIf(process.platform === "win32")("rejects symlinks inside legacy metadata without moving it", async () => {
    const cwd = await workspace();
    const legacy = legacyMetadataRoot(cwd);
    const outside = join(cwd, "outside.txt");
    await mkdir(legacy, { recursive: true });
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(legacy, "sessions"));

    await expect(ensureProject(cwd)).rejects.toThrow(/symbolic link/);
    await expect(readFile(join(legacy, "sessions"), "utf8")).resolves.toBe("outside");
    await expect(access(metadataRoot(cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
