import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, opendir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { metadataRoot, withFileWriteLock, writeJsonAtomic } from "../storage/persistence.js";
import { pathIsInside } from "../support/platform-utils.js";
import { resolveWorkspaceFile } from "../security/workspace-security.js";

export interface LegacyRecord { record_id?: string; record_type: string; loop_id?: string; candidate_id?: string; created_at?: string; payload: Record<string, unknown> }
/** Compatibility reader only. Never schedules, changes legacy status or rewrites the original log. */
export async function legacyMemoryRecords(cwd: string): Promise<LegacyRecord[]> {
  const root = metadataRoot(cwd); const path = join(root, "research-records-v2.jsonl");
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || (await lstat(root)).isSymbolicLink()) throw new Error("Legacy archive source must be a regular metadata file");
  const records: LegacyRecord[] = [];
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: LegacyRecord; try { row = JSON.parse(line); } catch { continue; /* retain the original torn tail on disk */ }
    if (row && typeof row.record_type === "string" && row.payload && typeof row.payload === "object") records.push(row);
  }
  return records;
}
async function archiveEntries(cwd: string) {
  const records = await legacyMemoryRecords(cwd);
  const groups = new Map<string, LegacyRecord[]>();
  for (const row of records) if (row.loop_id) { const rows = groups.get(row.loop_id) ?? []; rows.push(row); groups.set(row.loop_id, rows); }
  const evaluators = records.filter((row) => row.record_type.startsWith("evaluator."));
  return [...groups].map(([id, rows]) => {
    const description = Object.assign({}, ...rows.filter((row) => row.record_type.startsWith("loop.")).map((row) => row.payload));
    const digest = createHash("sha256").update(JSON.stringify({ records: rows, evaluators })).digest("hex");
    const directory = `research/archives/${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
    return { summary: { id, title: String(description.title ?? id), objective: String(description.objective ?? ""), status: String(description.status ?? "unknown"), path: `${directory}/history-${digest.slice(0, 16)}.json`, record_count: rows.length }, directory, digest, rows, evaluators };
  });
}
/** Listing reads metadata only; artifact export requires explicit archive access. */
export async function legacyArchives(cwd: string) { return (await archiveEntries(cwd)).map((entry) => entry.summary); }
export const LEGACY_EXPORT_LIMITS = { files: 1000, bytes: 64 * 1024 * 1024, milliseconds: 10_000 };
export async function exportLegacyArchive(cwd: string, id: string, limits = LEGACY_EXPORT_LIMITS) {
  const entry = (await archiveEntries(cwd)).find((entry) => entry.summary.id === id);
  if (!entry) return null;
  const { summary, directory, digest, rows, evaluators } = entry;
  const target = await archiveExportPath(cwd, summary.path);
  await withFileWriteLock(target, async () => {
    if (await readFile(target, "utf8").catch(() => null) !== null) return;
    const exported = await exportLegacyFiles(cwd, directory, rows, limits);
    await writeJsonAtomic(target, { source: "research-records-v2.jsonl", legacy_id: id, digest,
      continuation: "Resume with auto-research in Conversation; legacy scheduling is retired.", records: rows,
      exported_files: exported.files, export_truncated: exported.truncated, export_limits: limits, evaluators });
  });
  return summary;
}

/** Export only referenced solutions/runs from the trusted storage root. Refuse symlinks at either end. */
async function exportLegacyFiles(cwd: string, directory: string, rows: LegacyRecord[], limits: typeof LEGACY_EXPORT_LIMITS) {
  const files: Array<{ original_path: string; path: string }> = [];
  const roots = new Set<string>();
  const visited = new Set<string>(); let bytes = 0; let entries = 0; let truncated = false; const deadline = Date.now() + limits.milliseconds;
  const stateRoot = metadataRoot(cwd);
  for (const row of rows) {
    const solution = row.record_type === "candidate.proposed" ? (row.payload.solution as { path?: string } | undefined)?.path : undefined;
    const outputs = row.record_type === "candidate.execution_started" ? row.payload.outputs_dir : undefined;
    const input = typeof solution === "string" ? resolve(cwd, solution) : typeof outputs === "string" ? dirname(resolve(cwd, outputs)) : undefined;
    if (input && (pathIsInside(join(stateRoot, "solutions"), input) || pathIsInside(join(stateRoot, "runs"), input))) roots.add(input);
  }
  const canonicalState = await realpath(stateRoot).catch(() => stateRoot);
  const visit = async (source: string, destination: string): Promise<void> => {
    if (visited.has(source)) return; visited.add(source);
    if (entries >= limits.files || Date.now() >= deadline) { truncated = true; return; }
    entries++;
    const info = await lstat(source).catch(() => null);
    if (!info || info.isSymbolicLink() || !pathIsInside(canonicalState, await realpath(source))) return;
    const target = await archiveExportPath(cwd, destination);
    if ((await lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error("Archive export must not traverse symlinks");
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true });
      const directory = await opendir(source);
      for await (const entry of directory) {
        if (entries >= limits.files || Date.now() >= deadline) { truncated = true; break; }
        await visit(join(source, entry.name), `${destination}/${entry.name}`);
      }
    } else if (info.isFile()) {
      if (bytes + info.size > limits.bytes) { truncated = true; return; }
      bytes += info.size;
      await mkdir(dirname(target), { recursive: true });
      // COPYFILE_EXCL keeps an existing exported result intact.
      await copyFile(source, target, 1).catch((error) => { if (error.code !== "EEXIST") throw error; });
      files.push({ original_path: relative(cwd, source).replaceAll("\\", "/"), path: destination });
    }
  };
  for (const root of roots) await visit(root, `${directory}/files/${createHash("sha256").update(relative(stateRoot, root)).digest("hex").slice(0, 16)}`);
  return { files, truncated };
}

async function archiveExportPath(cwd: string, path: string): Promise<string> {
  const target = await resolveWorkspaceFile(cwd, path);
  let current = cwd;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    if ((await lstat(current).catch(() => null))?.isSymbolicLink()) throw new Error("Archive export must not traverse symlinks");
  }
  return target;
}
