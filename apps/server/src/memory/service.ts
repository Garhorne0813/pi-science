import { relative } from "node:path";
import { isArtifactSurfaceablePath } from "../runtime/artifacts/artifact-surface-policy.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { contentSchema, MemoryError, type MemoryContext } from "./schema.js";
import type { SqliteStateStore } from "../storage/sqlite/state-store.js";
import type { WorkspaceRepository } from "../storage/sqlite/repositories/workspace-repository.js";
import {
  resolveWorkspaceFile,
  validateWorkspaceCwd,
} from "../security/workspace-security.js";
import { readJsonLines, workspaceFile } from "../storage/persistence.js";
import { sessionRepository } from "../runtime/node/session-repository.js";
import { executionRepository } from "../runtime/executions/execution-repository.js";
export const LOCAL_OWNER = "local-owner";
export class MemoryService {
  constructor(
    readonly store: SqliteStateStore,
    private workspaces: WorkspaceRepository,
    private durableWrites = true,
  ) {}
  async context(
    cwdValue: string,
    actor: MemoryContext["actor"] = "user",
    sessionId?: string,
  ): Promise<{ cwd: string; context: MemoryContext }> {
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(cwdValue);
    } catch (error) {
      throw new MemoryError(403, String(error));
    }
    await this.store.start();
    const workspace = await this.workspaces.rememberWorkspace(cwd, {
      touch: false,
    });
    if (sessionId && !(await sessionRepository.findPath(cwd, sessionId)))
      throw new MemoryError(404, "Session not found in this project");
    // Register project scheduling independently of the global settings screen.
    // Read/poll requests must not reset the user's idle timer.
    await this.store.run('INSERT INTO memory_dream_schedules VALUES(?,?,?,?) ON CONFLICT(owner_id,project_id) DO UPDATE SET cwd=excluded.cwd',[LOCAL_OWNER,workspace.project_id,cwd,Date.now()]);
    return {
      cwd,
      context: {
        ownerId: LOCAL_OWNER,
        projectId: workspace.project_id,
        actor,
        sessionId,
      },
    };
  }
  async command<T = any>(
    ctx: MemoryContext,
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<T> {
    if (
      action === "settings.update" &&
      !this.durableWrites &&
      (input.settings as { enabled?: boolean } | undefined)?.enabled
    )
      throw new MemoryError(
        409,
        "Memory requires persistent SQLite state; enable PI_SCIENCE_SQLITE_STATE",
      );
    return this.store.memory<T>({ context: ctx, action, input });
  }
  async recall(
    cwd: string,
    ctx: MemoryContext,
    input: Record<string, unknown>,
  ) {
    const result = await this.command<{
      records: import("./schema.js").MemoryRecord[];
    }>(ctx, "recall", input);
    const records: import("./schema.js").MemoryRecord[] = [];
    for (const record of result.records) {
      try {
        const { pickContent } = await import("./repository.js");
        await this.validateContent(
          cwd,
          { ...ctx, actor: "user" },
          pickContent(record),
        );
        records.push(record);
      } catch (error) {
        await this.command(ctx, "mark.stale", {
          id: record.id,
          expectedRevision: record.revision,
          contentHash: record.contentHash,
        }).catch(() => undefined);
      }
    }
    return { records };
  }
  async validateContent(cwd: string, ctx: MemoryContext, input: unknown) {
    const c = contentSchema.parse(input);
    if (
      c.subjectFrameId &&
      !(await sessionRepository.findPath(cwd, c.subjectFrameId))
    )
      throw new MemoryError(400, "Frame session does not exist");
    if (c.scope === "artifact") {
      const artifacts = await readJsonLines<{
        artifact_id: string;
        version: number;
      }>(workspaceFile(cwd, "artifacts.jsonl"));
      if (
        !artifacts.some(
          (a) =>
            a.artifact_id === c.artifactId &&
            (!c.artifactVersionId || String(a.version) === c.artifactVersionId),
        )
      )
        throw new MemoryError(400, "Artifact/version not found");
    }
    for (const source of c.sources) {
      let sourceCwd = cwd;
      if (source.projectId && source.projectId !== ctx.projectId) {
        if (ctx.actor !== "user")
          throw new MemoryError(
            403,
            "Source is outside the current authorized project",
          );
        const locations = await this.workspaces.getByProject(source.projectId);
        const location = locations.find((l) => !l.missing_since);
        if (!location)
          throw new MemoryError(400, "Source project is unavailable");
        sourceCwd = await validateWorkspaceCwd(location.canonical_path);
      } else source.projectId = ctx.projectId;
      switch (source.kind) {
        case "message": {
          // Message locators are sessionId@messageId. Tools receive the current trusted session automatically.
          const split = source.locator.lastIndexOf("@");
          const sid =
            split >= 0 ? source.locator.slice(0, split) : ctx.sessionId;
          const id =
            split >= 0 ? source.locator.slice(split + 1) : source.locator;
          if (
            !sid ||
            !(await sessionRepository.findPath(sourceCwd, sid)) ||
            (["agent", "extractor"].includes(ctx.actor) &&
              sid !== ctx.sessionId)
          )
            throw new MemoryError(
              400,
              "Message session outside authorized range",
            );
          const message = (
            await sessionRepository.messages(sourceCwd, sid)
          ).find((m) => m.id === id);
          if (!message) throw new MemoryError(400, "Message source not found");
          if (c.evidenceLevel === "user_stated" && message.role !== "user")
            throw new MemoryError(
              400,
              "user_stated evidence must refer to a user message",
            );
          source.locator = `${sid}@${id}`;
          break;
        }
        case "session":
          if (!(await sessionRepository.findPath(sourceCwd, source.locator)))
            throw new MemoryError(400, "Session source not found");
          break;
        case "run":
          if (!(await executionRepository.get(sourceCwd, source.locator)))
            throw new MemoryError(400, "Execution source not found");
          break;
        case "artifact": {
          const artifacts = await readJsonLines<{
            artifact_id: string;
            version: number;
            sha256: string;
          }>(workspaceFile(sourceCwd, "artifacts.jsonl"));
          const a = artifacts.find(
            (a) =>
              a.artifact_id === source.locator &&
              String(a.version) === source.version,
          );
          if (!a)
            throw new MemoryError(
              400,
              "Artifact source requires an existing version",
            );
          if (source.digest && source.digest !== a.sha256)
            throw new MemoryError(409, "Artifact source digest changed");
          source.digest = a.sha256;
          break;
        }
        case "file": {
          const path = await resolveWorkspaceFile(sourceCwd, source.locator);
          if (
            !isArtifactSurfaceablePath(source.locator) ||
            !isArtifactSurfaceablePath(relative(sourceCwd, path))
          )
            throw new MemoryError(
              403,
              "Private file cannot be a memory source",
            );
          const info = await stat(path);
          if (!info.isFile() || info.size > 8 * 1024 * 1024)
            throw new MemoryError(400, "Source file too large");
          const digest = createHash("sha256")
            .update(await readFile(path))
            .digest("hex");
          if (source.digest && source.digest !== digest)
            throw new MemoryError(
              409,
              "File evidence changed; create a new revision",
            );
          source.digest = digest;
          break;
        }
        case "memory": {
          await this.command(
            { ...ctx, projectId: source.projectId ?? ctx.projectId },
            "read",
            { id: source.locator },
          );
          break;
        }
        case "citation":
          throw new MemoryError(
            400,
            "Use a local literature file or Artifact as a verifiable citation source",
          );
      }
    }
    return c;
  }
}
export function memoryGrant(cwd: string, sessionId: string, secret: string) {
  const payload = Buffer.from(
    JSON.stringify({ cwd, sessionId, expires: Date.now() + 60000 }),
  ).toString("base64url");
  return (
    payload +
    "." +
    createHmac("sha256", secret).update(payload).digest("base64url")
  );
}
export function verifyMemoryGrant(
  grant: unknown,
  secret?: string,
): { cwd: string; sessionId: string } {
  if (typeof grant !== "string" || !secret || grant.length > 4096)
    throw new MemoryError(403, "Memory runtime capability required");
  const [payload, sig, extra] = grant.split(".");
  const a = Buffer.from(sig ?? "", "base64url"),
    b = createHmac("sha256", secret)
      .update(payload ?? "")
      .digest();
  if (extra || a.length !== b.length || !timingSafeEqual(a, b))
    throw new MemoryError(403, "Invalid memory capability");
  const v = JSON.parse(Buffer.from(payload!, "base64url").toString());
  if (
    typeof v.cwd !== "string" ||
    typeof v.sessionId !== "string" ||
    v.expires < Date.now()
  )
    throw new MemoryError(403, "Expired memory capability");
  return { cwd: v.cwd, sessionId: v.sessionId };
}
