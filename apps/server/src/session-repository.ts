import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface SessionInfoRecord {
  id: string;
  cwd: string;
  name: null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionMessageRecord {
  id: string;
  role: string;
  content: Array<Record<string, unknown>>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: string | null;
}

interface SessionFile {
  path: string;
  header: Record<string, unknown>;
  modified: Date;
}

function sessionsRoot(cwd: string): string {
  return join(resolve(cwd), ".pi-science", "sessions");
}

async function sessionFiles(root: string): Promise<SessionFile[]> {
  const result: SessionFile[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const handle = await open(path, "r");
        const buffer = Buffer.alloc(64 * 1024);
        let bytesRead = 0;
        try { ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0)); }
        finally { await handle.close(); }
        const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]?.trim();
        if (!firstLine) continue;
        const header = JSON.parse(firstLine) as Record<string, unknown>;
        if (header.type !== "session" || typeof header.id !== "string") continue;
        const metadata = await stat(path);
        result.push({ path, header, modified: metadata.mtime });
      } catch {
        // A partially-written or corrupt session is ignored just like Python.
      }
    }
  }

  await visit(root);
  return result.sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

export class SessionRepository {
  async findPath(cwd: string, sessionId: string): Promise<string | null> {
    return (await sessionFiles(sessionsRoot(cwd))).find(({ header }) => header.id === sessionId)?.path ?? null;
  }

  async list(cwd: string): Promise<SessionInfoRecord[]> {
    const files = await sessionFiles(sessionsRoot(cwd));
    return files.map(({ header, modified }) => ({
      id: String(header.id),
      cwd: typeof header.cwd === "string" ? header.cwd : resolve(cwd),
      name: null,
      created_at: typeof header.timestamp === "string" ? header.timestamp : null,
      updated_at: modified.toISOString(),
    }));
  }

  async messages(cwd: string, sessionId: string): Promise<SessionMessageRecord[]> {
    const file = (await sessionFiles(sessionsRoot(cwd))).find(({ header }) => header.id === sessionId);
    if (!file) return [];
    const rows: SessionMessageRecord[] = [];
    try {
      const text = await readFile(file.path, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
          const message = entry.message as Record<string, unknown>;
          rows.push({
            id: typeof entry.id === "string" ? entry.id : "",
            role: typeof message.role === "string" ? message.role : "",
            content: Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [],
            toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
            toolName: typeof message.toolName === "string" ? message.toolName : undefined,
            isError: typeof message.isError === "boolean" ? message.isError : false,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
          });
        } catch {
          continue;
        }
      }
    } catch {
      return [];
    }
    return rows;
  }
}

export const sessionRepository = new SessionRepository();
