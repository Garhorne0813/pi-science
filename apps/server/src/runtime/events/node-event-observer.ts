import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { appendJsonLine, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { collapseManifests } from "../artifacts/artifact-manifest.js";
import type { ArtifactManifestV2 } from "../artifacts/artifact-manifest.js";
import type { PiEvent } from "../pi/pi-process.js";

type Publish = (payload: Record<string, unknown>) => Promise<void>;

const queues = new Map<string, Promise<void>>();

function serialized(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(key, next);
  void next.then(() => { if (queues.get(key) === next) queues.delete(key); }, () => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

function mime(path: string): string {
  const table: Record<string, string> = {
    ".json": "application/json", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
    ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".pdf": "application/pdf",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  };
  return table[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function kind(path: string, contentType: string): string {
  const ext = extname(path).toLowerCase();
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("text/") || [".json", ".yaml", ".yml", ".py", ".r", ".sh"].includes(ext)) return "text";
  if ([".csv", ".tsv", ".xlsx", ".parquet"].includes(ext)) return "table";
  if ([".pdf", ".docx", ".pptx"].includes(ext)) return "document";
  if ([".pdb", ".cif", ".mol", ".sdf", ".xyz"].includes(ext)) return "structure";
  return "file";
}

export async function observeNodePiEvent(
  cwd: string,
  model: string | null,
  event: PiEvent,
  sessionId: string,
  publish: Publish,
): Promise<void> {
  if (["agent_start", "agent_end", "agent_settled", "error"].includes(event.type)) {
    void serialized(workspaceFile(cwd, "skill-events.jsonl"), () => appendJsonLine(workspaceFile(cwd, "skill-events.jsonl"), {
      type: "skill_event", session_id: sessionId, ts: Date.now() / 1000, event: event.type,
    })).catch(() => undefined);
  }
  if (event.type === "tool_execution_end") {
    void serialized(workspaceFile(cwd, "skill-events.jsonl"), () => appendJsonLine(workspaceFile(cwd, "skill-events.jsonl"), {
      type: "skill_event", session_id: sessionId, ts: Date.now() / 1000, event: "tool",
      tool: String(event.toolName ?? ""), status: event.isError ? "error" : "ok",
    })).catch(() => undefined);
    if (!event.isError) await observeWrittenArtifact(cwd, model, event, sessionId, publish);
  }
}

async function observeWrittenArtifact(cwd: string, model: string | null, event: PiEvent, sessionId: string, publish: Publish): Promise<void> {
  const tool = String(event.toolName ?? "");
  if (tool !== "write" && tool !== "edit") return;
  const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
  const rawPath = String(args.file_path ?? args.path ?? "");
  if (!rawPath) return;
  const workspace = resolve(cwd);
  const absolute = resolve(workspace, rawPath);
  const path = relative(workspace, absolute).replaceAll("\\", "/");
  if (!path || path.startsWith("../") || path === "..") return;
  let metadata;
  let bytes: Buffer;
  try {
    metadata = await stat(absolute);
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024 * 1024) return;
    bytes = await readFile(absolute);
  } catch {
    return;
  }
  await serialized(workspaceFile(cwd, "artifacts.jsonl"), async () => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactId = createHash("sha256").update(`${workspace}:${path}`).digest("hex").slice(0, 24);
    // Collapse duplicate artifact_id+version rows (verification updates append
    // a refreshed row for an OLD version) and take the highest version, so a
    // stale verification row at the tail can never reset the version counter.
    const manifests = collapseManifests(await readJsonLines<unknown>(workspaceFile(cwd, "artifacts.jsonl")));
    const previous = manifests.filter((item) => item.artifact_id === artifactId).sort((left, right) => right.version - left.version)[0];
    const previousVersion = Number(previous?.version ?? 0);
    if (previous?.sha256 === sha256) return;
    // Stable logical identity: inherit the same-path chain's identity (so a
    // renamed file keeps one lineage), otherwise mint a fresh one.
    const logicalId = previous?.logical_id ?? randomUUID();
    const contentType = mime(path);
    const verification = { status: "passed", checks: { exists: true, readable: true, size: metadata.size, sha256 }, checked_at: new Date().toISOString() };
    const manifest: ArtifactManifestV2 = {
      schema_version: 2, artifact_id: artifactId, logical_id: logicalId, version: previousVersion + 1, path, kind: kind(path, contentType), mime: contentType,
      size: metadata.size, sha256, published_at: new Date().toISOString(),
      producer: { tool, session_id: sessionId, ...(model ? { model } : {}) }, inputs: [], supersedes: null, classification: "intermediate", environment: {}, verification,
    };
    await appendJsonLine(workspaceFile(cwd, "artifacts.jsonl"), manifest);
    await appendProvenance(cwd, path, tool, sessionId, model, event, sha256, artifactId, previousVersion + 1);
    await publish({ type: "artifact.published", sessionId, artifactId, path, version: previousVersion + 1, mime: contentType, verification });
  }).catch(() => undefined);
}

async function appendProvenance(cwd: string, path: string, tool: string, sessionId: string, model: string | null, event: PiEvent, sha256: string, artifactId: string, artifactVersion: number): Promise<void> {
  const records = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "provenance.jsonl"));
  const version = records.filter((record) => record.path === path).reduce((max, record) => Math.max(max, Number(record.version ?? 0)), 0) + 1;
  const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
  const result = event.result && typeof event.result === "object" ? event.result as Record<string, unknown> : {};
  const content = tool === "write" ? String(args.content ?? args.text ?? "").slice(0, 100_000) : undefined;
  await appendJsonLine(workspaceFile(cwd, "provenance.jsonl"), {
    path, version, ts: Date.now() / 1000, tool, toolCallId: String(event.toolCallId ?? ""), sessionId,
    ...(model ? { model } : {}), ...(content ? { content, contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16) } : {}),
    ...(tool === "edit" && result.diff ? { diff: String(result.diff).slice(0, 100_000) } : {}),
    artifactId, artifactVersion, artifactHash: sha256,
  });
}
