import { randomUUID } from "node:crypto";
import { readJson, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";

export type ResponseVersionStatus = "ready" | "generating" | "failed";

export interface ResponseVersion {
  id: string;
  sessionId: string;
  userMessageId: string | null;
  parentSessionId: string | null;
  forkEntryId: string | null;
  createdAt: string;
  status: ResponseVersionStatus;
}

export interface ResponseVersionGroup {
  id: string;
  versions: ResponseVersion[];
}

interface ResponseVersionDocument {
  schemaVersion: 1;
  groups: ResponseVersionGroup[];
}

const EMPTY: ResponseVersionDocument = { schemaVersion: 1, groups: [] };
const MAX_GROUPS = 100;
const MAX_VERSIONS_PER_GROUP = 50;

function pathFor(cwd: string): string {
  return workspaceFile(cwd, "response-versions.json");
}

function validDocument(value: ResponseVersionDocument): ResponseVersionDocument {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.groups)) return EMPTY;
  return value;
}

export class ResponseVersionRepository {
  async list(cwd: string, sessionId?: string): Promise<ResponseVersionGroup[]> {
    const document = validDocument(await readJson<ResponseVersionDocument>(pathFor(cwd), EMPTY));
    return sessionId
      ? document.groups.filter((group) => group.versions.some((version) => version.sessionId === sessionId))
      : document.groups;
  }

  async append(cwd: string, input: {
    sourceSessionId: string;
    sourceUserMessageId: string;
    targetSessionId: string;
    forkEntryId?: string;
  }): Promise<{ group: ResponseVersionGroup; version: ResponseVersion }> {
    const path = pathFor(cwd);
    return withFileWriteLock(path, async () => {
      const document = validDocument(await readJson<ResponseVersionDocument>(path, EMPTY));
      let group = document.groups.find((candidate) => candidate.versions.some((version) => (
        version.sessionId === input.sourceSessionId && version.userMessageId === input.sourceUserMessageId
      )));
      if (!group) {
        group = {
          id: randomUUID(),
          versions: [{
            id: randomUUID(),
            sessionId: input.sourceSessionId,
            userMessageId: input.sourceUserMessageId,
            parentSessionId: null,
            forkEntryId: null,
            createdAt: new Date().toISOString(),
            status: "ready",
          }],
        };
        document.groups.push(group);
      }
      const existing = group.versions.find((version) => version.sessionId === input.targetSessionId);
      const version = existing ?? {
        id: randomUUID(),
        sessionId: input.targetSessionId,
        userMessageId: null,
        parentSessionId: input.sourceSessionId,
        forkEntryId: input.forkEntryId ?? null,
        createdAt: new Date().toISOString(),
        status: "generating" as const,
      };
      if (!existing) group.versions.push(version);
      group.versions = group.versions.slice(-MAX_VERSIONS_PER_GROUP);
      document.groups = document.groups.slice(-MAX_GROUPS);
      await writeJsonAtomic(path, document);
      return { group, version };
    });
  }

  async bind(cwd: string, versionId: string, userMessageId: string): Promise<ResponseVersion | null> {
    return this.update(cwd, versionId, (version) => ({ ...version, userMessageId }));
  }

  async setStatus(cwd: string, versionId: string, status: ResponseVersionStatus): Promise<ResponseVersion | null> {
    return this.update(cwd, versionId, (version) => ({ ...version, status }));
  }

  async setSessionStatus(cwd: string, sessionId: string, status: ResponseVersionStatus): Promise<void> {
    const path = pathFor(cwd);
    await withFileWriteLock(path, async () => {
      const document = validDocument(await readJson<ResponseVersionDocument>(path, EMPTY));
      let changed = false;
      for (const group of document.groups) {
        group.versions = group.versions.map((version) => {
          if (version.sessionId !== sessionId || version.status !== "generating") return version;
          changed = true;
          return { ...version, status };
        });
      }
      if (changed) await writeJsonAtomic(path, document);
    });
  }

  private async update(cwd: string, versionId: string, mutate: (version: ResponseVersion) => ResponseVersion): Promise<ResponseVersion | null> {
    const path = pathFor(cwd);
    return withFileWriteLock(path, async () => {
      const document = validDocument(await readJson<ResponseVersionDocument>(path, EMPTY));
      for (const group of document.groups) {
        const index = group.versions.findIndex((version) => version.id === versionId);
        if (index < 0) continue;
        const updated = mutate(group.versions[index]!);
        group.versions[index] = updated;
        await writeJsonAtomic(path, document);
        return updated;
      }
      return null;
    });
  }
}

export const responseVersionRepository = new ResponseVersionRepository();
