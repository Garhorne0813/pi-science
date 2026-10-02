import { stat } from "node:fs/promises";
import { boundedToolDetails } from "../node/message-details.js";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv, laneConfig, type Entry, type JsonlSessionMetadata, type LaneConfiguration } from "@earendil-works/pi-agent-core/node";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { readProject } from "../../project/project-registry.js";
import { metadataRoot } from "../../storage/persistence.js";
import type { SessionStats } from "@pi-science/contracts";
import { appliedRuntimeSettings, contextUsage } from "./agent-runtime-settings.js";
import type { SessionInfoRecord, SessionMessagePage, SessionMessageRecord, SessionUserMessageIndexEntry } from "../node/session-repository.js";

const context = BACKGROUND_CONTEXT;
const PAGE_SIZE = 50;

function asMessage(entry: Entry): SessionMessageRecord | null {
  if (entry.type !== "message") return null;
  const message = entry.message as unknown as Record<string, unknown>;
  return {
    id: entry.id,
    role: String(message.role ?? ""),
    ...(typeof message.client_message_id === "string" ? { client_message_id: message.client_message_id } : {}),
    content: Array.isArray(message.content) ? message.content as Array<Record<string, unknown>>
      : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [],
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
    ...(boundedToolDetails(message.details) === undefined ? {} : { details: boundedToolDetails(message.details) }),
    timestamp: new Date(entry.timestamp).toISOString(),
  };
}

/** Read-only projection of AgentHarness v4 sessions into the existing browser history protocol. */
export class AgentSessionRepository {
  private readonly registry = new AgentSessionRegistry();
  private async withRepo<T>(cwd: string, read: (repo: JsonlSessionRepo) => Promise<T>): Promise<T> {
    const environment = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fileSystem: environment, sessionsRoot: join(metadataRoot(cwd), "agent-sessions") });
    try { return await read(repo); }
    finally {
      await repo.close(context);
      await environment.cleanup(context);
    }
  }

  private async metadata(repo: JsonlSessionRepo, cwd: string, sessionId: string): Promise<JsonlSessionMetadata | undefined> {
    if ((await this.registry.get(cwd, sessionId))?.state === "deleted") return undefined;
    return (await repo.list({ cwd }, context)).find((item) => item.id === sessionId);
  }

  async configuration(cwd: string, sessionId: string): Promise<LaneConfiguration | null> {
    return this.withRepo(cwd, async (repo) => {
      const metadata = await this.metadata(repo, cwd, sessionId);
      if (!metadata) return null;
      const session = await repo.open(metadata, context);
      try { return (await session.getValue(laneConfig("main"), context))?.value ?? null; }
      finally { await session.close(context); }
    });
  }

  async findPath(cwd: string, sessionId: string): Promise<string | null> {
    return this.withRepo(cwd, async (repo) => (await this.metadata(repo, cwd, sessionId))?.path ?? null);
  }

  async runtimeState(cwd: string, sessionId: string) {
    return this.withRepo(cwd, async (repo) => {
      const metadata = await this.metadata(repo, cwd, sessionId);
      if (!metadata) throw new Error("agent session not found");
      const session = await repo.open(metadata, context);
      try {
        const applied = (await session.getValue(appliedRuntimeSettings, context))?.value;
        const branch = await session.branch("main", context);
        return { ...await contextUsage(await branch?.findEntries({ order: "oldestFirst" }, context) ?? [], applied?.contextWindow ?? null),
          compaction_enabled: applied?.compaction.enabled,
          compaction_threshold_percent: applied?.thresholdPercent ?? null };
      } finally { await session.close(context); }
    });
  }

  async list(cwd: string): Promise<SessionInfoRecord[]> {
    const project = await readProject(cwd);
    const registered = await this.registry.all(cwd);
    return this.withRepo(cwd, async (repo) => (await repo.list({ cwd }, context))
      .filter((item) => {
        const owner = Object.hasOwn(registered, item.id) ? registered[item.id] : undefined;
        return owner?.state !== "deleted" && (owner ? (owner.purpose ?? "conversation") === "conversation" : !item.parentSessionId);
      })
      .map((item) => ({
        id: item.id,
        cwd,
        project_id: project?.id ?? null,
        name: null,
        created_at: new Date(item.createdAt).toISOString(),
        updated_at: new Date(item.modifiedAt).toISOString(),
      })));
  }

  async messages(cwd: string, sessionId: string): Promise<SessionMessageRecord[]> {
    return this.withRepo(cwd, async (repo) => {
      const metadata = await this.metadata(repo, cwd, sessionId);
      if (!metadata) return [];
      const session = await repo.open(metadata, context);
      try { return (await session.findEntries({ order: "asc" }, context)).flatMap((entry) => asMessage(entry) ?? []); }
      finally { await session.close(context); }
    });
  }

  async stats(cwd: string, sessionId: string): Promise<SessionStats | null> {
    return this.withRepo(cwd, async (repo) => {
      const metadata = await this.metadata(repo, cwd, sessionId);
      if (!metadata) return null;
      const session = await repo.open(metadata, context);
      try {
        const [entries, totals] = await Promise.all([session.findEntries({ type: "message" }, context), session.getStats(context)]);
        const messages = entries.flatMap((entry) => asMessage(entry) ?? []);
        const userMessages = messages.filter((message) => message.role === "user").length;
        const assistantMessages = messages.filter((message) => message.role === "assistant").length;
        const toolResults = messages.filter((message) => message.role === "toolResult").length;
        const toolCalls = messages.filter((message) => message.role === "assistant")
          .flatMap((message) => message.content).filter((part) => part.type === "toolCall").length;
        const usage = totals.usage;
        return { userMessages, assistantMessages, toolCalls, toolResults, totalMessages: messages.length,
          tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite, total: usage.totalTokens }, cost: usage.cost.total };
      } finally { await session.close(context); }
    });
  }

  async messagesPage(cwd: string, sessionId: string, options: { before?: string; limit?: number } = {}): Promise<SessionMessagePage> {
    const limit = options.limit ?? PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("history limit must be between 1 and 100");
    let cursor: { seq: number } | undefined;
    if (options.before) {
      try {
        const decoded = JSON.parse(Buffer.from(options.before, "base64url").toString("utf8")) as { v?: unknown; s?: unknown };
        if (decoded.v !== 4 || !Number.isSafeInteger(decoded.s) || Number(decoded.s) < 1) throw new Error();
        cursor = { seq: Number(decoded.s) };
      } catch { throw new Error("invalid history cursor"); }
    }
    return this.withRepo(cwd, async (repo) => {
      const metadata = await this.metadata(repo, cwd, sessionId);
      if (!metadata) return { messages: [], next_cursor: null, has_more: false, snapshot_version: "0:0" };
      const session = await repo.open(metadata, context);
      try {
        const [entries, file] = await Promise.all([
          session.findEntries({ type: "message", order: "desc", limit: limit + 1, cursor }, context),
          stat(metadata.path),
        ]);
        const selected = entries.slice(0, limit).reverse();
        const oldest = selected[0];
        return { messages: selected.flatMap((entry) => asMessage(entry) ?? []),
          next_cursor: entries.length > limit && oldest
            ? Buffer.from(JSON.stringify({ v: 4, s: oldest.seq })).toString("base64url") : null,
          has_more: entries.length > limit,
          snapshot_version: `${file.size}:${file.mtimeMs}` };
      } finally { await session.close(context); }
    });
  }

  async userMessageIndex(cwd: string, sessionId: string): Promise<{ messages: SessionUserMessageIndexEntry[]; snapshot_version: string }> {
    const path = await this.findPath(cwd, sessionId);
    if (!path) return { messages: [], snapshot_version: "0:0" };
    return this.withRepo(cwd, async (repo) => {
      const metadata = await this.metadata(repo, cwd, sessionId);
      if (!metadata) return { messages: [], snapshot_version: "0:0" };
      const session = await repo.open(metadata, context);
      try {
        const [entries, file] = await Promise.all([session.findEntries({ type: "message", order: "asc" }, context), stat(path)]);
        return { messages: entries.flatMap((entry) => {
        const message = asMessage(entry);
        if (!message) return [];
        if (message.role !== "user") return [];
        const text = message.content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n");
        if (!text) return [];
        return [{ id: message.id, text, timestamp: message.timestamp ?? null,
          before: Buffer.from(JSON.stringify({ v: 4, s: entry.seq + 1 })).toString("base64url") }];
        }), snapshot_version: `${file.size}:${file.mtimeMs}` };
      } finally { await session.close(context); }
    });
  }
}
