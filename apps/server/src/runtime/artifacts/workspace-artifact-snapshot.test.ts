import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffWorkspaceSnapshots, previewKind, previewMime, snapshotWorkspace, type WorkspaceSnapshotEntry } from "./workspace-artifact-snapshot.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  delete process.env.PI_SCIENCE_SNAPSHOT_CAP;
  delete process.env.PI_SCIENCE_SNAPSHOT_NODE_CAP;
});

async function workspace(): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(join(cwd, "work", "figures"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(cwd, ".pi-science", "sessions"), { recursive: true });
  await mkdir(join(cwd, ".venv", "lib"), { recursive: true });
  return cwd;
}

describe("workspace artifact snapshot", () => {
  it("records regular files recursively and ignores dependency/cache directories", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "downloads", "proteins"), { recursive: true });
    await writeFile(join(cwd, "work", "plot.png"), "png", "utf8");
    await writeFile(join(cwd, "work", "figures", "umap.csv"), "a,b\n", "utf8");
    await writeFile(join(cwd, "downloads", "proteins", "1abc.custom"), "structure", "utf8");
    await writeFile(join(cwd, "README.md"), "readme", "utf8");
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "x", "utf8");
    await writeFile(join(cwd, ".venv", "lib", "site.py"), "y", "utf8");
    await writeFile(join(cwd, ".pi-science", "sessions", "s.jsonl"), "z", "utf8");

    const snapshot = await snapshotWorkspace(cwd);
    expect(snapshot).not.toBeNull();
    const paths = (snapshot ?? []).map((entry) => entry.path).sort();
    expect(paths).toEqual(["README.md", "downloads/proteins/1abc.custom", "work/figures/umap.csv", "work/plot.png"]);
  });

  it("does not follow symlinks or surface credential-like files and hidden directories", async () => {
    const cwd = await workspace();
    const outside = join(tmpdir(), `pi-science-snapshot-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cleanup.push(outside);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(cwd, "linked-outside"), "dir");
    await mkdir(join(cwd, ".aws"), { recursive: true });
    await writeFile(join(cwd, ".aws", "credentials"), "secret", "utf8");
    await writeFile(join(cwd, ".env"), "TOKEN=secret", "utf8");
    await writeFile(join(cwd, "server.key"), "key", "utf8");
    await writeFile(join(cwd, "credentials.json"), "{}", "utf8");
    await writeFile(join(cwd, "secrets.yaml"), "token: secret", "utf8");
    await writeFile(join(cwd, "safe.unknown"), "safe", "utf8");

    const snapshot = await snapshotWorkspace(cwd);
    const paths = (snapshot ?? []).map((entry) => entry.path).sort();
    expect(paths).toContain("safe.unknown");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("server.key");
    expect(paths).not.toContain("credentials.json");
    expect(paths).not.toContain("secrets.yaml");
    expect(paths.some((path) => path.startsWith(".aws/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("linked-outside/"))).toBe(false);
  });

  it("normalizes windows-style separators to posix", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "work", "data.tsv"), "a\tb\n", "utf8");
    const snapshot = await snapshotWorkspace(cwd);
    const entry = (snapshot ?? []).find((item) => item.path.includes("data.tsv"));
    expect(entry?.path).toBe("work/data.tsv");
    expect(entry?.path).not.toContain("\\");
  });

  it("diffs created and modified files between snapshots", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "work", "a.csv"), "1\n", "utf8");
    await writeFile(join(cwd, "work", "b.md"), "old", "utf8");
    const before = await snapshotWorkspace(cwd);

    await writeFile(join(cwd, "work", "a.csv"), "1\n2\n", "utf8");
    await writeFile(join(cwd, "work", "c.png"), "img", "utf8");
    const after = await snapshotWorkspace(cwd);

    const diff = diffWorkspaceSnapshots(before, after!);
    expect(diff.created.map((entry) => entry.path)).toEqual(["work/c.png"]);
    expect(diff.modified.map((entry) => entry.path)).toEqual(["work/a.csv"]);
  });

  it("captures structure files under arbitrary scientific dirs", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "downloaded_structures"), { recursive: true });
    await writeFile(join(cwd, "downloaded_structures", "1HEL.pdb"), "ATOM  ...\n", "utf8");
    await writeFile(join(cwd, "downloaded_structures", "model.mmcif"), "data_model\n", "utf8");
    const before = await snapshotWorkspace(cwd);

    await writeFile(join(cwd, "downloaded_structures", "1CRN.pdb"), "ATOM  ...\n", "utf8");
    const after = await snapshotWorkspace(cwd);

    const paths = (after ?? []).map((entry) => entry.path).sort();
    expect(paths).toEqual(["downloaded_structures/1CRN.pdb", "downloaded_structures/1HEL.pdb", "downloaded_structures/model.mmcif"]);

    const diff = diffWorkspaceSnapshots(before, after!);
    expect(diff.created.map((entry) => entry.path)).toEqual(["downloaded_structures/1CRN.pdb"]);
    expect(diff.modified).toEqual([]);

    expect(previewKind("downloaded_structures/1CRN.pdb")).toBe("structure");
    expect(previewMime("downloaded_structures/1CRN.pdb")).toBe("chemical/x-pdb");
    expect(previewKind("downloaded_structures/model.mmcif")).toBe("structure");
    expect(previewMime("downloaded_structures/model.mmcif")).toBe("chemical/x-cif");
  });

  it("treats a null baseline as no diff (degraded start)", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "work", "a.csv"), "1\n", "utf8");
    const after = await snapshotWorkspace(cwd);
    const diff = diffWorkspaceSnapshots(null, after!);
    expect(diff.created).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("degrades to null instead of diffing an entry-capped partial snapshot", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "work", "many"), { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      await writeFile(join(cwd, "work", "many", `f${String(index).padStart(2, "0")}.txt`), String(index), "utf8");
    }
    process.env.PI_SCIENCE_SNAPSHOT_CAP = "10";
    expect(await snapshotWorkspace(cwd)).toBeNull();
  });

  it("bounds visited nodes even when entries are directories, symlinks, or excluded files", async () => {
    const cwd = await workspace();
    const many = join(cwd, "many-nodes");
    await mkdir(many, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      await mkdir(join(many, `dir-${String(index).padStart(2, "0")}`), { recursive: true });
    }
    process.env.PI_SCIENCE_SNAPSHOT_NODE_CAP = "8";
    expect(await snapshotWorkspace(cwd)).toBeNull();
  });

  it("returns stable path order for complete snapshots", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "z-dir"), { recursive: true });
    await mkdir(join(cwd, "a-dir"), { recursive: true });
    await writeFile(join(cwd, "z-dir", "b.txt"), "b", "utf8");
    await writeFile(join(cwd, "a-dir", "a.txt"), "a", "utf8");
    const first = await snapshotWorkspace(cwd);
    const second = await snapshotWorkspace(cwd);
    expect(first?.map((entry) => entry.path)).toEqual(second?.map((entry) => entry.path));
  });
});
