import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { readJson, readJsonLines, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import type { ConversationEventHub } from "../events/conversation-event-hub.js";
import { diffWorkspaceSnapshots, previewKind, previewMime, snapshotWorkspace, type WorkspaceSnapshotEntry } from "./workspace-artifact-snapshot.js";
import { turnArtifactRepository } from "./turn-artifact-repository.js";

export interface TurnArtifactContext {
  cwd: string;
  turnId?: string;
  turnOrdinal?: number;
  turnBaseline?: Promise<WorkspaceSnapshotEntry[] | null>;
  turnAssistantPartId?: string;
}

type DurableTurn = {
  operationId: string;
  baseline: WorkspaceSnapshotEntry[] | null;
  turnId: string;
  turnOrdinal?: number;
  assistantPartId?: string;
  completed: boolean;
  started?: boolean;
};

/** Product lifecycle records survive worker/server restarts; the session log
 * remains the authority for whether the operation was actually admitted. */
export class DurableTurnLifecycle {
  private readonly anchors = new Map<string, string>();
  constructor(private readonly events: ConversationEventHub) {}

  private file(cwd: string, sessionId: string, operationId: string): string {
    return workspaceFile(cwd, `turn-lifecycle/${createHash("sha256").update(`${sessionId}\0${operationId}`).digest("hex")}.json`);
  }

  async prepare(cwd: string, sessionId: string, operationId: string): Promise<void> {
    const file = this.file(cwd, sessionId, operationId);
    await withFileWriteLock(file, async () => {
      if (await readJson<DurableTurn | null>(file, null)) return;
      const baseline = await snapshotWorkspace(cwd);
      await writeJsonAtomic(file, { operationId, baseline, turnId: operationId, completed: false } satisfies DurableTurn);
    });
  }

  async unfinished(cwd: string, sessionId: string, operationId: string): Promise<boolean> {
    const record = await readJson<DurableTurn | null>(this.file(cwd, sessionId, operationId), null);
    return Boolean(record && !record.completed);
  }

  async discardRejected(cwd: string, sessionId: string, operationId: string): Promise<void> {
    const file = this.file(cwd, sessionId, operationId);
    await withFileWriteLock(file, async () => {
      const record = await readJson<DurableTurn | null>(file, null);
      if (record && !record.started && !record.completed) await unlink(file);
    });
  }

  async observe(cwd: string, sessionId: string, event: Record<string, unknown>, identity?: { turnId: string; turnOrdinal: number }): Promise<boolean> {
    const operationId = typeof event.runId === "string" ? event.runId : "";
    if (!operationId) return false;
    const file = this.file(cwd, sessionId, operationId);
    if (event.type === "message.updated") {
      const message = event.message as { id?: string } | undefined;
      const update = event.content as { type?: string } | undefined;
      if (message?.id && ["text_delta", "text", "text_end"].includes(update?.type ?? "")) this.anchors.set(file, message.id);
      return false;
    }
    if (event.type !== "operation.started" && event.type !== "operation.settled") return false;
    return withFileWriteLock(file, async () => {
      const record = await readJson<DurableTurn | null>(file, null);
      if (!record || record.completed) return false;
      if (event.type === "operation.started") {
        record.started = true;
        record.turnId = identity?.turnId ?? record.turnId;
        record.turnOrdinal = identity?.turnOrdinal ?? record.turnOrdinal;
        await writeJsonAtomic(file, record);
        return false;
      }
      await finishTurnArtifacts(this.events, { cwd, turnId: record.turnId, turnOrdinal: record.turnOrdinal,
        turnBaseline: Promise.resolve(record.baseline), turnAssistantPartId: this.anchors.get(file) ?? record.assistantPartId }, event, sessionId);
      this.anchors.delete(file);
      record.completed = true;
      record.baseline = null;
      await writeJsonAtomic(file, record);
      return true;
    });
  }
}

export async function finishTurnArtifacts(events: ConversationEventHub, runtime: TurnArtifactContext, event: Record<string, unknown>, sessionId: string): Promise<void> {
    const turnId = runtime.turnId;
    if (!turnId) return;
    runtime.turnId = undefined;
    const baseline = runtime.turnBaseline;
    runtime.turnBaseline = undefined;
    if (!baseline) return;
    const turnOrdinal = runtime.turnOrdinal ?? null;
    const endedAt = new Date().toISOString();
    const lastAssistantPartId = runtime.turnAssistantPartId;
    const before = await baseline;
    const after = await snapshotWorkspace(runtime.cwd);
    if (!after) return;
    const { created, modified } = diffWorkspaceSnapshots(before, after);
    const changed = [...created, ...modified];
    if (changed.length === 0) return;
    const items = await toTurnArtifactItems(runtime.cwd, changed);
    if (items.length === 0) return;
    // The tracked last assistant message id of this turn is the most accurate
    // anchor (PRD: artifact cards must land after the turn's FINAL assistant
    // message). A settled event's own ids may point to an earlier message of
    // a multi-message turn, so they are consulted only as secondary fallbacks.
    const assistantMessageId = lastAssistantPartId
      ?? (typeof event.assistantMessageId === "string"
        ? event.assistantMessageId
        : typeof event.messageId === "string"
          ? event.messageId
          : null);
    const record = {
      turn_id: turnId,
      session_id: sessionId,
      assistant_message_id: assistantMessageId,
      turn_ordinal: turnOrdinal,
      ended_at: endedAt,
      artifacts: items,
    };
    // Defensive idempotency: a reconciliation-recovered turn and a late
    // (replayed) operation.settled could both carry the same turn id; never append
    // a duplicate record for one turn.
    const existing = await turnArtifactRepository.forSession(runtime.cwd, sessionId).catch(() => []);
    if (existing.some((r) => r.turn_id === turnId)) return;
    await turnArtifactRepository.append(runtime.cwd, record);
    await events.publish(runtime.cwd, sessionId, {
      type: "turn.artifacts",
      sessionId,
      turnId,
      turnOrdinal,
      assistantMessageId,
      // Published so the live fold can anchor the strip the same way the
      // history restore does. `turnOrdinal` is diagnostic and resets with the hub,
      // not user-message turns, so it cannot identify the owning turn on its own.
      endedAt,
      artifacts: items,
    }).catch(() => undefined);
  }

async function toTurnArtifactItems(cwd: string, entries: WorkspaceSnapshotEntry[]): Promise<Array<{ path: string; kind: string; mime: string; size: number; artifactId?: string; version?: number }>> {
    let manifests: Array<{ artifact_id?: string; version?: unknown; path?: unknown }> = [];
    try {
      manifests = await readJsonLines<{ artifact_id?: string; version?: unknown; path?: unknown }>(workspaceFile(cwd, "artifacts.jsonl"));
    } catch {
      manifests = [];
    }
    const byPath = new Map<string, { artifactId: string; version: number }>();
    for (const manifest of manifests) {
      const path = typeof manifest.path === "string" ? manifest.path : "";
      if (!path || typeof manifest.artifact_id !== "string") continue;
      byPath.set(path, { artifactId: manifest.artifact_id, version: Number(manifest.version ?? 0) });
    }
    return entries
      .map((entry) => {
        const manifest = byPath.get(entry.path);
        return {
          path: entry.path,
          kind: previewKind(entry.path),
          mime: previewMime(entry.path),
          size: entry.size,
          ...(manifest ? { artifactId: manifest.artifactId, version: manifest.version } : {}),
        };
      })
      .sort((a, b) => b.size - a.size)
      .slice(0, 12);
  }
