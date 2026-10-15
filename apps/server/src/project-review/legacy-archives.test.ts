import { mkdtemp, mkdir, stat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { exportLegacyArchive, legacyArchives, legacyMemoryRecords } from "./legacy-archives.js";
import { appendJsonLine, metadataRoot } from "../storage/persistence.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
it.each([false, true])("keeps records and result bytes accessible without restarting historical work (relocated=%s)", async (relocated) => {
  const cwd = await mkdtemp(join(tmpdir(), "legacy-archives-")); roots.push(cwd); await mkdir(join(cwd, ".pi-science"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, ".test-home"));
  if (relocated) { const { workspaceStateRoot } = await import("../storage/persistence.js"); await mkdir(workspaceStateRoot(cwd), { recursive: true }); }
  const storage = metadataRoot(cwd); const log = join(storage, "research-records-v2.jsonl");
  const output = join(storage, "runs/run-old/outputs"); await mkdir(output, { recursive: true }); await writeFile(join(output, "results.csv"), "metric,value\nrmse,0.25\n");
  await appendJsonLine(log, { record_type: "loop.created", loop_id: "old", payload: { title: "Original", objective: "Optimize", status: "running" } });
  await appendJsonLine(log, { record_type: "candidate.execution_started", loop_id: "old", payload: { outputs_dir: output, job_id: "job-old" } });
  await appendJsonLine(log, { record_type: "candidate.evaluated", loop_id: "old", payload: { evaluation: { metrics: { rmse: 0.25 }, artifact_refs: [{ path: "results.csv" }] } } });
  await appendJsonLine(log, { record_type: "evaluator.registered", payload: { evaluator_id: "original", version: 1 } });
  const original = await readFile(log, "utf8");
  const archives = await legacyArchives(cwd); expect(archives).toHaveLength(1); expect(archives[0]).toMatchObject({ title: "Original", status: "running", record_count: 3 });
  await expect(stat(join(cwd, "research"))).rejects.toMatchObject({ code: "ENOENT" });
  await exportLegacyArchive(cwd, "old");
  const archived = JSON.parse(await readFile(join(cwd, archives[0]!.path), "utf8"));
  expect(archived.records).toEqual((await legacyMemoryRecords(cwd)).filter((row) => row.loop_id === "old")); expect(archived.evaluators).toHaveLength(1);
  expect(await readFile(join(cwd, archived.exported_files[0].path), "utf8")).toBe("metric,value\nrmse,0.25\n");
  expect(await legacyArchives(cwd)).toEqual(archives); expect(await readFile(log, "utf8")).toBe(original);
});
it("refuses workspace-external export paths and skips symlinked source artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "legacy-archive-security-")); roots.push(cwd); await mkdir(join(cwd, ".pi-science"));
  const outside = await mkdtemp(join(tmpdir(), "legacy-archive-outside-")); roots.push(outside);
  await writeFile(join(outside, "secret"), "must not export");
  const output = join(metadataRoot(cwd), "runs/run-old/outputs"); await mkdir(output, { recursive: true }); await symlink(join(outside, "secret"), join(output, "link"));
  await appendJsonLine(join(metadataRoot(cwd), "research-records-v2.jsonl"), { record_type: "candidate.execution_started", loop_id: "old", payload: { outputs_dir: output } });
  const [archive] = await legacyArchives(cwd); await exportLegacyArchive(cwd, "old"); expect(JSON.parse(await readFile(join(cwd, archive!.path), "utf8")).exported_files).toEqual([]);
  await rm(join(cwd, "research"), { recursive: true }); await symlink(outside, join(cwd, "research"));
  await expect(exportLegacyArchive(cwd, "old")).rejects.toThrow("escapes");
});

it.each(["bytes", "files", "milliseconds"] as const)("bounds explicit artifact export by %s and retains original references", async (limit) => {
  const cwd = await mkdtemp(join(tmpdir(), "legacy-archive-limits-")); roots.push(cwd); await mkdir(join(cwd, ".pi-science"));
  const output = join(metadataRoot(cwd), "runs/large/outputs"); await mkdir(output, { recursive: true }); await writeFile(join(output, "large.csv"), "0123456789");
  await appendJsonLine(join(metadataRoot(cwd), "research-records-v2.jsonl"), { record_type: "candidate.execution_started", loop_id: "large", payload: { outputs_dir: output } });
  const [listed] = await legacyArchives(cwd); await expect(stat(join(cwd, "research"))).rejects.toMatchObject({ code: "ENOENT" });
  await exportLegacyArchive(cwd, "large", { files: 100, bytes: 100, milliseconds: 10000, [limit]: limit === "bytes" ? 5 : limit === "files" ? 2 : 0 });
  const manifest = JSON.parse(await readFile(join(cwd, listed!.path), "utf8"));
  expect(manifest.export_truncated).toBe(true); expect(manifest.exported_files).toEqual([]);
  expect(manifest.records[0].payload.outputs_dir).toBe(output); expect(await readFile(join(output, "large.csv"), "utf8")).toBe("0123456789");
  expect(await exportLegacyArchive(cwd, "missing")).toBeNull();
});
