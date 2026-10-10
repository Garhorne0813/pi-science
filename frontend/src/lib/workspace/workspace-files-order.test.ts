import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileListEntry } from "../../components/sidebar/FileContextMenu";
import { sortFileEntries, workspaceFiles } from "./workspace-files";

const entry = (name: string, isDir: boolean): FileListEntry => ({
  path: name, name, isDir, size: 0, modified: 1,
});

afterEach(() => vi.restoreAllMocks());

describe("sortFileEntries", () => {
  it("groups folders first and sorts file2 before file10 without changing the input", () => {
    const entries = [
      entry("file10.csv", false), entry("Dir10", true),
      entry("file2.csv", false), entry("dir2", true),
    ];
    expect(sortFileEntries(entries).map(item => item.name))
      .toEqual(["dir2", "Dir10", "file2.csv", "file10.csv"]);
    expect(entries.map(item => item.name))
      .toEqual(["file10.csv", "Dir10", "file2.csv", "dir2"]);
  });

  it("sorts before limiting root results to 30 entries", async () => {
    const entries = [
      ...Array.from({ length: 32 }, (_, i) => entry(`file${i + 1}.csv`, false)),
      entry("Dir10", true), entry("dir2", true), entry(".hidden", true),
    ];
    vi.spyOn(workspaceFiles, "directory").mockResolvedValue({ entries, breadcrumbs: [] });
    const result = await workspaceFiles.sidebar("proj");
    expect(result).toHaveLength(30);
    expect(result.slice(0, 2).map(item => item.name)).toEqual(["dir2", "Dir10"]);
    expect(result.every(item => !item.name.startsWith("."))).toBe(true);
  });
});
