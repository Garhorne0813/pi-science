// Immutable output writer tests (docs §9.10, §14.2 Output/Security rows):
// no-overwrite, concurrent-safety and lexical path containment.
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAttemptOutputDir, isSafeRelativeOutputPath, OUTPUT_EXISTS, OutputExistsError, resolveInside, writeImmutableFile } from "./immutable-output.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  cleanup.push(dir);
  return dir;
}

describe("writeImmutableFile", () => {
  it("publishes content at mode 0600 through the temp→fsync→rename sequence", async () => {
    const dir = await tempDir("immutable-publish");
    const target = await writeImmutableFile(dir, "report.md", "# digest");
    expect(target).toBe(join(dir, "report.md"));
    await expect(readFile(target, "utf8")).resolves.toBe("# digest");
    if (process.platform !== "win32") {
      const info = await stat(target);
      expect(info.mode & 0o777).toBe(0o600);
    }
    // No temp leftovers in the attempt directory.
    await expect(readdir(dir)).resolves.toEqual(["report.md"]);
  });

  it("refuses to overwrite an existing target (OUTPUT_EXISTS) and keeps its content", async () => {
    const dir = await tempDir("immutable-nooverwrite");
    await writeFile(join(dir, "run.json"), '{"original":true}', "utf8");
    let error: unknown;
    try {
      await writeImmutableFile(dir, "run.json", '{"rewritten":true}');
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(OutputExistsError);
    expect((error as OutputExistsError).code).toBe(OUTPUT_EXISTS);
    await expect(readFile(join(dir, "run.json"), "utf8")).resolves.toBe('{"original":true}');
  });

  it("is concurrency-safe: exactly one of N racing writers publishes, losers fail safely", async () => {
    const dir = await tempDir("immutable-concurrent");
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => writeImmutableFile(dir, "sources.json", `{"writer":${index}}`)),
    );
    const fulfilled = attempts.filter((entry) => entry.status === "fulfilled");
    const rejected = attempts.filter((entry) => entry.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    for (const failure of rejected) expect((failure.reason as OutputExistsError).code).toBe(OUTPUT_EXISTS);
    const published = JSON.parse(await readFile(join(dir, "sources.json"), "utf8")) as { writer: number };
    expect(Number.isInteger(published.writer)).toBe(true);
    // Exactly one file, no orphaned temps from the losing writers.
    await expect(readdir(dir)).resolves.toEqual(["sources.json"]);
  });

  it("rejects .. traversal, absolute names and .pi-science components", async () => {
    const dir = await tempDir("immutable-containment");
    await mkdir(join(dir, "nested"), { recursive: true });
    await expect(writeImmutableFile(dir, "../escape.md", "x")).rejects.toThrow(/unsafe output path|escapes its base/);
    await expect(writeImmutableFile(dir, "nested/../../escape.md", "x")).rejects.toThrow();
    await expect(writeImmutableFile(dir, join(dir, "absolute.md"), "x")).rejects.toThrow(/unsafe output path/);
    await expect(writeImmutableFile(dir, ".pi-science/state.json", "x")).rejects.toThrow(/unsafe output path/);
    await expect(writeImmutableFile(join(dir, ".pi-science"), "state.json", "x")).rejects.toThrow(/managed metadata/);
    // Nothing was written outside the directory.
    await expect(readdir(dir)).resolves.toEqual(["nested"]);
  });

  it("supports nested relative names inside the directory", async () => {
    const dir = await tempDir("immutable-nested");
    const target = await writeImmutableFile(dir, "attempts/satt_1/report.md", "body");
    await expect(readFile(target, "utf8")).resolves.toBe("body");
    await expect(writeImmutableFile(dir, "attempts/satt_1/report.md", "other")).rejects.toBeInstanceOf(OutputExistsError);
  });
});

describe("ensureAttemptOutputDir", () => {
  it("creates the directory recursively and is idempotent", async () => {
    const root = join(await tempDir("immutable-dir"), "reports/literature/st_1/2026-02-08/srun_1/satt_1");
    const created = await ensureAttemptOutputDir(root);
    expect(created).toBe(root);
    const info = await stat(root);
    expect(info.isDirectory()).toBe(true);
    await expect(ensureAttemptOutputDir(root)).resolves.toBe(root);
  });

  it("rejects roots that traverse the managed .pi-science directory", async () => {
    const root = join(await tempDir("immutable-dir-guard"), ".pi-science", "outputs");
    await expect(ensureAttemptOutputDir(root)).rejects.toThrow(/managed metadata/);
  });
});

describe("resolveInside / isSafeRelativeOutputPath", () => {
  it("accepts plain relative output paths and rejects every escape form", () => {
    expect(isSafeRelativeOutputPath("reports/literature/st_1/2026-02-08/r/a/sources.json")).toBe(true);
    expect(isSafeRelativeOutputPath("")).toBe(false);
    expect(isSafeRelativeOutputPath("/etc/passwd")).toBe(false);
    expect(isSafeRelativeOutputPath("../outside.json")).toBe(false);
    expect(isSafeRelativeOutputPath("reports/../..")).toBe(false);
    expect(isSafeRelativeOutputPath(".pi-science/x")).toBe(false);
    expect(resolveInside("/ws", "reports/literature/x.json")).toBe("/ws/reports/literature/x.json");
    expect(() => resolveInside("/ws", "../sibling.json")).toThrow(/unsafe output path/);
    expect(() => resolveInside("/ws", "/abs.json")).toThrow(/unsafe output path/);
  });
});
