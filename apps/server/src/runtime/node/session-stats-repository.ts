import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { sessionStatsSchema, type SessionStats } from "@pi-science/contracts";

/** Whole-session stats checkpoint storage, one JSON file per session next to
 *  the session JSONL (`<cwd>/.pi-science/sessions/stats/<id>.json`). The file
 *  is the refresh-recovery source when the Pi runtime is idle: counters come
 *  from `get_session_stats` at turn end, timing comes from the control-plane
 *  event-stream projector. */

function statsDir(cwd: string): string {
  return join(resolve(cwd), ".pi-science", "sessions", "stats");
}

function statsPath(cwd: string, sessionId: string): string {
  return join(statsDir(cwd), `${sessionId}.json`);
}

export async function saveSessionStats(cwd: string, sessionId: string, stats: SessionStats): Promise<void> {
  const target = statsPath(cwd, sessionId);
  const temp = `${target}.tmp`;
  await mkdir(statsDir(cwd), { recursive: true });
  await writeFile(temp, JSON.stringify(stats), "utf8");
  await rename(temp, target);
}

export async function loadSessionStats(cwd: string, sessionId: string): Promise<SessionStats | null> {
  try {
    const raw = await readFile(statsPath(cwd, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = sessionStatsSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function deleteSessionStats(cwd: string, sessionId: string): Promise<void> {
  try {
    await unlink(statsPath(cwd, sessionId));
  } catch {
    // File already gone — nothing to delete.
  }
}

interface FoldedLineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function usageNumbers(value: unknown): FoldedLineUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const num = (key: string) => Number(usage[key] ?? 0);
  return { input: num("input"), output: num("output"), cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite") };
}

/** Cold-start fallback: fold a session JSONL into whole-session counters when
 *  no checkpoint exists (sessions created before this feature shipped). Token
 *  usage is summed from assistant messages and toolResult messages that carry
 *  a nested `usage` block; tool calls are deduped by id. Timing is not
 *  recoverable from the file, so the caller keeps timing fields as-is. */
export async function foldSessionFileStats(path: string): Promise<SessionStats> {
  const state = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    toolCallIds: new Set<string>(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return;
      const message = entry.message as Record<string, unknown>;
      const role = String(message.role ?? "");
      state.totalMessages += 1;
      const usage = usageNumbers(message.usage);
      if (role === "user") {
        state.userMessages += 1;
      } else if (role === "assistant") {
        state.assistantMessages += 1;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
          const record = part && typeof part === "object" ? part as Record<string, unknown> : {};
          if (record.type === "toolCall" && typeof record.id === "string" && record.id) {
            state.toolCallIds.add(record.id);
          }
        }
      } else if (role === "toolResult") {
        state.toolResults += 1;
        if (typeof message.toolCallId === "string" && message.toolCallId) state.toolCallIds.add(message.toolCallId);
      }
      state.tokens.input += usage.input;
      state.tokens.output += usage.output;
      state.tokens.cacheRead += usage.cacheRead;
      state.tokens.cacheWrite += usage.cacheWrite;
      state.tokens.total += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      const usageRecord = message.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : {};
      const costRecord = usageRecord.cost && typeof usageRecord.cost === "object" ? usageRecord.cost as Record<string, unknown> : {};
      state.cost += Number(costRecord.total ?? 0);
    });
    lines.on("close", () => resolvePromise());
    lines.on("error", reject);
  });
  state.toolCalls = state.toolCallIds.size;
  return {
    userMessages: state.userMessages,
    assistantMessages: state.assistantMessages,
    toolCalls: state.toolCalls,
    toolResults: state.toolResults,
    totalMessages: state.totalMessages,
    tokens: state.tokens,
    ...(state.cost > 0 ? { cost: state.cost } : {}),
  };
}
