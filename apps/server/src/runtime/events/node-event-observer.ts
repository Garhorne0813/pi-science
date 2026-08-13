import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { appendJsonLine, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import type { PiEvent } from "../pi/pi-process.js";
import { executionIdFor, executionRepository } from "../executions/execution-repository.js";

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
  if (event.type === "tool_execution_start") {
    const toolCallId = String(event.toolCallId ?? "");
    if (toolCallId) {
      const tool = String(event.toolName ?? "unknown");
      await executionRepository.start(cwd, {
        execution_id: executionIdFor("pi-tool", sessionId, toolCallId),
        kind: "tool",
        surface: "pi",
        producer: "node-pi-event-observer",
        correlation: { session_id: sessionId, tool_call_id: toolCallId },
        request: { tool, input: redactValue(event.args ?? {}) },
        runtime: model ? { model } : {},
        files: explicitToolFiles(tool, event.args),
      }).catch(() => undefined);
    }
  }
  if (event.type === "tool_execution_end") {
    void serialized(workspaceFile(cwd, "skill-events.jsonl"), () => appendJsonLine(workspaceFile(cwd, "skill-events.jsonl"), {
      type: "skill_event", session_id: sessionId, ts: Date.now() / 1000, event: "tool",
      tool: String(event.toolName ?? ""), status: event.isError ? "error" : "ok",
    })).catch(() => undefined);
    const artifact = event.isError ? null : await observeWrittenArtifact(cwd, model, event, sessionId, publish);
    const toolCallId = String(event.toolCallId ?? "");
    if (toolCallId) {
      await executionRepository.finish(cwd, executionIdFor("pi-tool", sessionId, toolCallId), {
        status: event.isError ? "failed" : "succeeded",
        producer: "node-pi-event-observer",
        result: event.isError
          ? { error: cappedText(event.result ?? event.error ?? "Tool execution failed") }
          : { output_preview: cappedText(redactValue(event.result ?? "")) },
        ...(artifact ? {
          files: { written: [{ path: artifact.path, sha256: artifact.sha256, artifact_id: artifact.artifactId, artifact_version: artifact.version, detection: "explicit" }] },
          artifacts: [{ artifact_id: artifact.artifactId, version: artifact.version, relation: "output" }],
        } : {}),
      }).catch(() => undefined);
    }
  }
}

interface ObservedArtifact { path: string; sha256: string; artifactId: string; version: number }

async function observeWrittenArtifact(cwd: string, model: string | null, event: PiEvent, sessionId: string, publish: Publish): Promise<ObservedArtifact | null> {
  const tool = String(event.toolName ?? "");
  if (tool !== "write" && tool !== "edit") return null;
  const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
  const rawPath = String(args.file_path ?? args.path ?? "");
  if (!rawPath) return null;
  const workspace = resolve(cwd);
  const absolute = resolve(workspace, rawPath);
  const path = relative(workspace, absolute).replaceAll("\\", "/");
  if (!path || path.startsWith("../") || path === "..") return null;
  let metadata;
  let bytes: Buffer;
  try {
    metadata = await stat(absolute);
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024 * 1024) return null;
    bytes = await readFile(absolute);
  } catch {
    return null;
  }
  let observed: ObservedArtifact | null = null;
  await serialized(workspaceFile(cwd, "artifacts.jsonl"), async () => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactId = createHash("sha256").update(`${workspace}:${path}`).digest("hex").slice(0, 24);
    const artifacts = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    const previous = artifacts.filter((item) => item.artifact_id === artifactId).at(-1);
    const previousVersion = Number(previous?.version ?? 0);
    if (previous?.sha256 === sha256) {
      observed = { path, sha256, artifactId, version: previousVersion };
      return;
    }
    const contentType = mime(path);
    const verification = { status: "passed", checks: { exists: true, readable: true, size: metadata.size, sha256 }, checked_at: new Date().toISOString() };
    const manifest = {
      artifact_id: artifactId, version: previousVersion + 1, path, kind: kind(path, contentType), mime: contentType,
      size: metadata.size, sha256, published_at: new Date().toISOString(),
      producer: { tool, session_id: sessionId, ...(model ? { model } : {}) }, inputs: [], environment: {}, verification,
    };
    await appendJsonLine(workspaceFile(cwd, "artifacts.jsonl"), manifest);
    await appendProvenance(cwd, path, tool, sessionId, model, event, sha256, artifactId, previousVersion + 1);
    await publish({ type: "artifact.published", sessionId, artifactId, path, version: previousVersion + 1, mime: contentType, verification });
    observed = { path, sha256, artifactId, version: previousVersion + 1 };
  }).catch(() => undefined);
  return observed;
}

async function appendProvenance(cwd: string, path: string, tool: string, sessionId: string, model: string | null, event: PiEvent, sha256: string, artifactId: string, artifactVersion: number): Promise<void> {
  const records = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "provenance.jsonl"));
  const version = records.filter((record) => record.path === path).reduce((max, record) => Math.max(max, Number(record.version ?? 0)), 0) + 1;
  const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
  const result = event.result && typeof event.result === "object" ? event.result as Record<string, unknown> : {};
  const content = tool === "write" ? String(args.content ?? args.text ?? "").slice(0, 100_000) : undefined;
  await appendJsonLine(workspaceFile(cwd, "provenance.jsonl"), {
    path, version, ts: Date.now() / 1000, tool, toolCallId: String(event.toolCallId ?? ""), sessionId,
    executionId: executionIdFor("pi-tool", sessionId, String(event.toolCallId ?? "")),
    ...(model ? { model } : {}), ...(content ? { content, contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16) } : {}),
    ...(tool === "edit" && result.diff ? { diff: String(result.diff).slice(0, 100_000) } : {}),
    artifactId, artifactVersion, artifactHash: sha256,
  });
}

function explicitToolFiles(tool: string, args: unknown): Partial<{ read: Array<{ path: string; detection: "explicit" }>; written: Array<{ path: string; detection: "explicit" }> }> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return {};
  const input = args as Record<string, unknown>;
  const path = [input.file_path, input.path].find((value): value is string => typeof value === "string" && value.length > 0);
  if (!path) return {};
  if (["write", "edit"].includes(tool)) return { written: [{ path, detection: "explicit" }] };
  if (["read", "read_file", "view_image"].includes(tool)) return { read: [{ path, detection: "explicit" }] };
  return {};
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 64_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([key, item]) => [
    key,
    /(?:api[_-]?key|token|secret|password|authorization|credential|cookie)/i.test(key) ? "[redacted]" : redactValue(item, depth + 1),
  ]));
}

function cappedText(value: unknown): string {
  if (typeof value === "string") return value.slice(-64_000);
  try { return JSON.stringify(value).slice(-64_000); } catch { return String(value).slice(-64_000); }
}
