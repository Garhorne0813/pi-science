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

  it("reserves bounded slots for recent uploads without hiding folders unnecessarily", async () => {
    const entries = [
      ...Array.from({ length: 2000 }, (_, i) => entry(`file${i}.csv`, false)),
      entry("work", true), entry("z-upload.csv", false), entry(".uploaded", false), entry(".hidden", false),
    ];
    vi.spyOn(workspaceFiles, "directory").mockResolvedValue({ entries, breadcrumbs: [] });
    const result = await workspaceFiles.sidebar("proj", undefined, ["z-upload.csv", ".uploaded"]);
    expect(result).toHaveLength(30);
    expect(result.map(item => item.path)).toEqual(expect.arrayContaining(["work", "z-upload.csv", ".uploaded"]));
    expect(result.some(item => item.path === ".hidden")).toBe(false);
    expect((await workspaceFiles.sidebar("other")).some(item => item.path === "z-upload.csv")).toBe(false);
  });

  it("limits reservations to the latest 30 paths and drops removed files on subsequent reads", async () => {
    let entries = Array.from({ length: 100 }, (_, i) => entry(`upload${i}.csv`, false));
    vi.spyOn(workspaceFiles, "directory").mockImplementation(async () => ({ entries, breadcrumbs: [] }));
    const recent = entries.map(item => item.path);
    expect(await workspaceFiles.sidebar("proj", undefined, recent)).toEqual(entries.slice(-30));
    entries = entries.filter(item => item.path !== "upload99.csv");
    const refreshed = await workspaceFiles.sidebar("proj", undefined, recent);
    expect(refreshed).toHaveLength(30);
    expect(refreshed.some(item => item.path === "upload99.csv")).toBe(false);
  });

  it.each([30, 50])("keeps root folders when %i recent uploads exceed the remaining slots", async (count) => {
    const folders = [entry("work", true), entry("data", true), entry("reports", true)];
    const uploads = Array.from({ length: count }, (_, i) => entry(`upload${i}.csv`, false));
    vi.spyOn(workspaceFiles, "directory").mockResolvedValue({ entries: [...folders, ...uploads], breadcrumbs: [] });
    const result = await workspaceFiles.sidebar("proj", undefined, uploads.map(item => item.path));
    expect(result).toHaveLength(30);
    expect(result.filter(item => item.isDir).map(item => item.path)).toEqual(["data", "reports", "work"]);
    expect(result.filter(item => !item.isDir)).toEqual(uploads.slice(-27));
  });

  it("keeps the directory-first limit when folders alone fill the sidebar", async () => {
    const folders = Array.from({ length: 35 }, (_, i) => entry(`dir${i}`, true));
    const uploads = Array.from({ length: 30 }, (_, i) => entry(`upload${i}.csv`, false));
    vi.spyOn(workspaceFiles, "directory").mockResolvedValue({ entries: [...uploads, ...folders], breadcrumbs: [] });
    const result = await workspaceFiles.sidebar("proj", undefined, uploads.map(item => item.path));
    expect(result).toEqual(folders.slice(0, 30));
  });

});
