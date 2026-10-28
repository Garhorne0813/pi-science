import type { PiConfig } from "@pi-science/contracts";
import { randomUUID } from "node:crypto";
import { workspaceIdentity } from "../workspace-session-identity.js";
import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { metadataRoot, writeJsonAtomic } from "../../../storage/persistence.js";
import type { RuntimeResult } from "../agent-runtime-types.js";
import { isAiTitlePrompt } from "../../title/title-prompt.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { configPath, failed } from "./identity.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "importLegacyOnce" | "open" | "owns" | "registry" | "repository" | "withMutation">;

export async function importLegacy(context: Context, cwd: string, sessionId: string, source: string, config: PiConfig, options: { activate?: boolean } = {}): Promise<RuntimeResult> {
  return context.withMutation(cwd, sessionId, () => context.importLegacyOnce(cwd, sessionId, source, config, options)).catch(failed);
}

export async function importLegacyOnce(context: Context, cwd: string, sessionId: string, source: string, config: PiConfig, options: { activate?: boolean }): Promise<RuntimeResult> {
  if ((await context.registry.get(cwd, sessionId))?.state === "deleted") return { success: false, code: "not_found", error: "session was deleted" };
  if (await context.owns(cwd, sessionId)) return { success: true };
  const handle = await open(source, "r");
  let firstLine = "";
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
  } finally { await handle.close(); }
  let header: { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
  try { header = JSON.parse(firstLine) as typeof header; }
  catch { return { success: false, code: "legacy_session_invalid", error: "legacy session header is invalid" }; }
  if (header.type !== "session" || header.version !== 3 || header.id !== sessionId || typeof header.cwd !== "string" || workspaceIdentity(header.cwd) !== workspaceIdentity(cwd)) {
    return { success: false, code: "legacy_session_unsupported", error: "only workspace-local Pi v3 sessions can be imported" };
  }
  const directory = join(metadataRoot(cwd), "agent-sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}_${encodeURIComponent(sessionId)}.jsonl`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    // Validate the complete copied file before granting durable ownership.
    // Core tolerates damaged JSONL tails during ordinary crash recovery; an
    // explicit migration must reject corruption rather than silently drop it.
    const messageIds: string[] = [];
    let expectedMessages = 0;
    let hidden = relative(join(metadataRoot(cwd), "sessions"), source).split(/[/\\]/).slice(0, -1).some((part) => part.endsWith(".jsonl") || /^run-\d+$/.test(part) || /^(parallel|dynamic|async)-/.test(part));
    const ids = new Set<string>();
    const lines = createInterface({ input: createReadStream(temporary), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { type?: string; id?: string; parentId?: string | null; name?: string; message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> } };
        if (entry.type === "session") continue;
        if (typeof entry.id !== "string" || ids.has(entry.id)) throw new Error("Legacy transcript has missing or duplicate entry IDs");
        if (entry.parentId && !ids.has(entry.parentId)) throw new Error("Legacy transcript has a missing parent entry");
        ids.add(entry.id);
        if (entry.type === "session_info" && entry.name?.startsWith("subagent-")) hidden = true;
        if (entry.message?.role === "user" && isAiTitlePrompt(typeof entry.message.content === "string" ? entry.message.content : (entry.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join(""))) hidden = true;
        if (entry.type === "message" || entry.type === "custom_message") { expectedMessages++; messageIds.push(entry.id); }
      }
    } finally { lines.close(); }
    await rename(temporary, destination);
    const imported = await context.repository.messages(cwd, sessionId);
    if (imported.length !== expectedMessages) throw new Error("Legacy import did not preserve every message");
    await context.repository.upgradeLegacy(cwd, sessionId, source, messageIds);
    await context.repository.runtimeState(cwd, sessionId);
    await writeJsonAtomic(configPath(cwd, sessionId), { skills: config.skills, model_context_window_override: config.model_context_window_override });
    await context.registry.register(cwd, sessionId, destination, source, hidden ? { purpose: "subagent" } : undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    await unlink(configPath(cwd, sessionId)).catch(() => undefined);
    return { success: false, code: "legacy_import_failed", error: String(error) };
  }
  // Copy/ownership are committed before starting a worker. An unavailable
  // model must not discard a completed migration or rediscover its backup.
  if (options.activate === false) return { success: true };
  const opened = await context.open(cwd, sessionId, config);
  return "success" in opened ? opened : { success: true };
}
