import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffWorkspaceSnapshots, previewKind, previewMime, snapshotWorkspace, type WorkspaceSnapshotEntry } from "./workspace-artifact-snapshot.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
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
  it("records previewable files and ignores dependency/cache directories", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "work", "plot.png"), "png", "utf8");
    await writeFile(join(cwd, "work", "figures", "umap.csv"), "a,b\n", "utf8");
    await writeFile(join(cwd, "README.md"), "readme", "utf8");
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "x", "utf8");
    await writeFile(join(cwd, ".venv", "lib", "site.py"), "y", "utf8");
    await writeFile(join(cwd, ".pi-science", "sessions", "s.jsonl"), "z", "utf8");

    const snapshot = await snapshotWorkspace(cwd);
    expect(snapshot).not.toBeNull();
    const paths = (snapshot ?? []).map((entry) => entry.path).sort();
    expect(paths).toEqual(["README.md", "work/figures/umap.csv", "work/plot.png"]);
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

    await writeFile(join(cwd, "work", "a.csv"), "1\n2\n", "utf8"); // modified
    await writeFile(join(cwd, "work", "c.png"), "img", "utf8"); // created
    const after = await snapshotWorkspace(cwd);

    const diff = diffWorkspaceSnapshots(before, after!);
    expect(diff.created.map((entry) => entry.path)).toEqual(["work/c.png"]);
    expect(diff.modified.map((entry) => entry.path)).toEqual(["work/a.csv"]);
  });

  it("captures structure files under scientific dirs as structure artifacts (regression: structures/)", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "structures"), { recursive: true });
    await writeFile(join(cwd, "structures", "1HEL.pdb"), "ATOM  ...\n", "utf8");
    await writeFile(join(cwd, "structures", "aspirin.sdf"), "aspirin\n", "utf8");
    const before = await snapshotWorkspace(cwd);

    await writeFile(join(cwd, "structures", "1CRN.pdb"), "ATOM  ...\n", "utf8");
    await writeFile(join(cwd, "structures", "caffeine.sdf"), "caffeine\n", "utf8");
    const after = await snapshotWorkspace(cwd);

    const paths = (after ?? []).map((entry) => entry.path).sort();
    expect(paths).toEqual(["structures/1CRN.pdb", "structures/1HEL.pdb", "structures/aspirin.sdf", "structures/caffeine.sdf"]);

    const diff = diffWorkspaceSnapshots(before, after!);
    expect(diff.created.map((entry) => entry.path).sort()).toEqual(["structures/1CRN.pdb", "structures/caffeine.sdf"]);
    expect(diff.modified).toEqual([]);

    const pdb = (after ?? []).find((entry) => entry.path === "structures/1CRN.pdb")!;
    const sdf = (after ?? []).find((entry) => entry.path === "structures/caffeine.sdf")!;
    expect(previewKind(pdb.path)).toBe("structure");
    expect(previewMime(pdb.path)).toBe("chemical/x-pdb");
    expect(previewKind(sdf.path)).toBe("structure");
    expect(previewMime(sdf.path)).toBe("chemical/x-mdl-sdfile");
  });

  it("treats a null baseline as no diff (degraded start)", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "work", "a.csv"), "1\n", "utf8");
    const after = await snapshotWorkspace(cwd);
    const diff = diffWorkspaceSnapshots(null, after!);
    expect(diff.created).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("bounded: stops collecting after the entry cap (env override)", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "work", "many"), { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      await writeFile(join(cwd, "work", "many", `f${index}.txt`), String(index), "utf8");
    }
    const original = process.env.PI_SCIENCE_SNAPSHOT_CAP;
    process.env.PI_SCIENCE_SNAPSHOT_CAP = "10";
    try {
      // snapshotEntryCap() reads the env per call, so a small cap genuinely
      // bounds the walk below the 30 files created above.
      const snapshot = await snapshotWorkspace(cwd);
      expect((snapshot ?? []).length).toBeLessThanOrEqual(10);
    } finally {
      if (original === undefined) delete process.env.PI_SCIENCE_SNAPSHOT_CAP;
      else process.env.PI_SCIENCE_SNAPSHOT_CAP = original;
    }
  });
});
