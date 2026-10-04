import { workspaceIdentity } from "./workspace-session-identity.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { metadataRoot } from "../../storage/persistence.js";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { loadDefaultPiConfig } from "./runtime-config.js";

export type MigrationRecord = { source: string; sessionId?: string; status: "converted" | "already-converted" | "deleted" | "would-convert" | "failed"; error?: string; entryIds?: Record<string, string> };

/** Offline import: no environment provisioning, worker, credentials, or provider calls. */
export async function migrateLegacySessions(cwd: string, dryRun = false): Promise<MigrationRecord[]> {
  const root = join(metadataRoot(cwd), "sessions");
  const core = new AgentCoreSessionService(new ConversationEventHub(), { environment: async () => { throw new Error("offline migration must not start a worker"); } });
  const registry = new AgentSessionRegistry();
  const repository = new AgentSessionRepository();
  const output: MigrationRecord[] = [];
  const files = async (directory: string): Promise<string[]> => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name))
        : entry.isFile() && entry.name.endsWith(".jsonl") ? [join(directory, entry.name)] : []))).flat().sort();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  for (const source of await files(root)) {
    let sessionId: string | undefined;
    try {
      const rows = (await readFile(source, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
      const header = rows[0];
      if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || typeof header.cwd !== "string" || workspaceIdentity(header.cwd) !== workspaceIdentity(cwd)) throw new Error("Expected a workspace-local v3 session header");
      sessionId = header.id;
      const ids = new Set<string>();
      for (const entry of rows.slice(1)) {
        if (entry.type === "session" || typeof entry.id !== "string" || ids.has(entry.id) || (entry.parentId && !ids.has(String(entry.parentId)))) throw new Error("Invalid or duplicate entry ID / missing parent");
        ids.add(entry.id);
      }
      const saved = await registry.get(cwd, sessionId);
      if (saved?.state === "deleted") { output.push({ source, sessionId, status: "deleted" }); continue; }
      if (await core.owns(cwd, sessionId)) { output.push({ source, sessionId, status: "already-converted", entryIds: await repository.migrationEntryIds(cwd, sessionId) }); continue; }
      if (dryRun) { output.push({ source, sessionId, status: "would-convert" }); continue; }
      const result = await core.importLegacy(cwd, sessionId, source, loadDefaultPiConfig(), { activate: false });
      output.push(result.success ? { source, sessionId, status: "converted", entryIds: await repository.migrationEntryIds(cwd, sessionId) }
        : { source, sessionId, status: "failed", error: result.error ?? result.code });
    } catch (error) { output.push({ source, sessionId, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
  }
  return output;
}
