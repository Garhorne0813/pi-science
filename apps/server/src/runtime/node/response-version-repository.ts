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
  /** Stable identity of the user-visible conversation containing this group. */
  rootSessionId: string;
  /** Session whose user message was regenerated to create this group. */
  sourceSessionId: string;
  sourceUserMessageId: string;
  versions: ResponseVersion[];
  selectedVersionId?: string;
  updatedAt?: string;
}

interface ResponseVersionDocument {
  schemaVersion: 1;
  groups: ResponseVersionGroup[];
  /** Complete session membership survives visible version/group retention. */
  lineages: Record<string, string[]>;
}

const MAX_GROUPS = 100;
const MAX_VERSIONS_PER_GROUP = 50;

function emptyDocument(): ResponseVersionDocument {
  return { schemaVersion: 1, groups: [], lineages: {} };
}

function pathFor(cwd: string): string {
  return workspaceFile(cwd, "response-versions.json");
}

function validDocument(value: ResponseVersionDocument): ResponseVersionDocument {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.groups)) return emptyDocument();
  // Version groups originally inferred both the conversation root and the
  // branch source from versions[0]. Reconstruct those fields in append order
  // so existing workspaces gain stable lineage without a schema migration.
  const storedLineages = value.lineages && typeof value.lineages === "object" ? value.lineages : {};
  const lineages: Record<string, string[]> = {};
  const rootBySession = new Map<string, string>();
  for (const [root, sessions] of Object.entries(storedLineages)) {
    if (!Array.isArray(sessions)) continue;
    lineages[root] = [...new Set([root, ...sessions.filter((session): session is string => typeof session === "string")])];
    for (const session of lineages[root]) rootBySession.set(session, root);
  }
  const groups = value.groups.flatMap((candidate) => {
    if (!candidate || !Array.isArray(candidate.versions) || candidate.versions.length === 0) return [];
    const legacy = candidate as ResponseVersionGroup & {
      rootSessionId?: string;
      sourceSessionId?: string;
      sourceUserMessageId?: string;
    };
    const source = legacy.sourceSessionId ?? legacy.versions[0]!.sessionId;
    const root = legacy.rootSessionId ?? rootBySession.get(source) ?? source;
    const group: ResponseVersionGroup = {
      ...legacy,
      rootSessionId: root,
      sourceSessionId: source,
      sourceUserMessageId: legacy.sourceUserMessageId ?? legacy.versions[0]!.userMessageId ?? "",
    };
    rootBySession.set(root, root);
    const lineage = new Set(lineages[root] ?? [root]);
    lineage.add(group.sourceSessionId);
    for (const version of group.versions) {
      rootBySession.set(version.sessionId, root);
      lineage.add(version.sessionId);
    }
    lineages[root] = [...lineage];
    return [group];
  });
  return { schemaVersion: 1, groups, lineages };
}

function retainVersions(versions: ResponseVersion[]): ResponseVersion[] {
  if (versions.length <= MAX_VERSIONS_PER_GROUP) return versions;
  // The source version is part of the group's identity and is also the route
  // back from regenerated responses. Keep it while bounding newer history.
  return [versions[0]!, ...versions.slice(-(MAX_VERSIONS_PER_GROUP - 1))];
}

function rootFor(document: ResponseVersionDocument, sessionId: string): string {
  for (const [root, sessions] of Object.entries(document.lineages)) {
    if (root === sessionId || sessions.includes(sessionId)) return root;
  }
  return document.groups.find((group) => (
    group.rootSessionId === sessionId || group.versions.some((version) => version.sessionId === sessionId)
  ))?.rootSessionId ?? sessionId;
}

export class ResponseVersionRepository {
  async list(cwd: string, sessionId?: string): Promise<ResponseVersionGroup[]> {
    const document = validDocument(await readJson<ResponseVersionDocument>(pathFor(cwd), emptyDocument()));
    const rootSessionId = sessionId ? rootFor(document, sessionId) : undefined;
    const groups = rootSessionId
      ? document.groups.filter((group) => group.rootSessionId === rootSessionId)
      : document.groups;
    // Older files predate persisted selection. The newest generated version
    // is the best reconstruction because regeneration immediately navigates
    // to that branch.
    return groups.map((group) => ({
      ...group,
      selectedVersionId: group.versions.some((version) => version.id === group.selectedVersionId && version.status !== "failed")
        ? group.selectedVersionId
        : group.versions.findLast((version) => version.status !== "failed")?.id,
      updatedAt: group.updatedAt ?? group.versions.at(-1)?.createdAt,
    }));
  }

  async append(cwd: string, input: {
    sourceSessionId: string;
    sourceUserMessageId: string;
    targetSessionId: string;
    forkEntryId?: string;
  }): Promise<{ group: ResponseVersionGroup; version: ResponseVersion }> {
    const path = pathFor(cwd);
    return withFileWriteLock(path, async () => {
      const document = validDocument(await readJson<ResponseVersionDocument>(path, emptyDocument()));
      let group = document.groups.find((candidate) => candidate.versions.some((version) => (
        version.sessionId === input.sourceSessionId && version.userMessageId === input.sourceUserMessageId
      )));
      if (!group) {
        const rootSessionId = rootFor(document, input.sourceSessionId);
        group = {
          id: randomUUID(),
          rootSessionId,
          sourceSessionId: input.sourceSessionId,
          sourceUserMessageId: input.sourceUserMessageId,
          versions: [{
            id: randomUUID(),
            sessionId: input.sourceSessionId,
            userMessageId: input.sourceUserMessageId,
            parentSessionId: null,
            forkEntryId: null,
            createdAt: new Date().toISOString(),
            status: "ready",
          }],
          selectedVersionId: undefined,
        };
        group.selectedVersionId = group.versions[0]!.id;
        document.groups.push(group);
      }
      const existing = group.versions.find((version) => version.sessionId === input.targetSessionId);
      const createdAt = new Date().toISOString();
      const version = existing ?? {
        id: randomUUID(),
        sessionId: input.targetSessionId,
        userMessageId: null,
        parentSessionId: input.sourceSessionId,
        forkEntryId: input.forkEntryId ?? null,
        createdAt,
        status: "generating" as const,
      };
      if (!existing) group.versions.push(version);
      document.lineages[group.rootSessionId] = [...new Set([
        ...(document.lineages[group.rootSessionId] ?? [group.rootSessionId]),
        input.sourceSessionId,
        input.targetSessionId,
      ])];
      group.updatedAt = createdAt;
      group.versions = retainVersions(group.versions);
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
      const document = validDocument(await readJson<ResponseVersionDocument>(path, emptyDocument()));
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

  async select(cwd: string, versionId: string): Promise<ResponseVersionGroup | null> {
    const path = pathFor(cwd);
    return withFileWriteLock(path, async () => {
      const document = validDocument(await readJson<ResponseVersionDocument>(path, emptyDocument()));
      const group = document.groups.find((candidate) => candidate.versions.some((version) => version.id === versionId));
      if (!group || group.versions.find((version) => version.id === versionId)?.status === "failed") return null;
      group.selectedVersionId = versionId;
      await writeJsonAtomic(path, document);
      return group;
    });
  }

  async conversation(cwd: string, sessionId: string): Promise<{ rootSessionId: string; sessionIds: string[] }> {
    const document = validDocument(await readJson<ResponseVersionDocument>(pathFor(cwd), emptyDocument()));
    const rootSessionId = rootFor(document, sessionId);
    const sessionIds = new Set<string>(document.lineages[rootSessionId] ?? [rootSessionId]);
    for (const group of document.groups) {
      if (group.rootSessionId !== rootSessionId) continue;
      sessionIds.add(group.sourceSessionId);
      for (const version of group.versions) sessionIds.add(version.sessionId);
    }
    sessionIds.add(sessionId);
    return { rootSessionId, sessionIds: [...sessionIds] };
  }

  async removeConversation(cwd: string, sessionId: string): Promise<string[]> {
    const path = pathFor(cwd);
    return withFileWriteLock(path, async () => {
      const document = validDocument(await readJson<ResponseVersionDocument>(path, emptyDocument()));
      const rootSessionId = rootFor(document, sessionId);
      const removed = document.groups.filter((group) => group.rootSessionId === rootSessionId);
      if (removed.length === 0) return [sessionId];
      const sessionIds = new Set<string>(document.lineages[rootSessionId] ?? [rootSessionId]);
      for (const group of removed) {
        sessionIds.add(group.sourceSessionId);
        for (const version of group.versions) sessionIds.add(version.sessionId);
      }
      sessionIds.add(sessionId);
      document.groups = document.groups.filter((group) => group.rootSessionId !== rootSessionId);
      delete document.lineages[rootSessionId];
      await writeJsonAtomic(path, document);
      return [...sessionIds];
    });
  }

  private async update(cwd: string, versionId: string, mutate: (version: ResponseVersion) => ResponseVersion): Promise<ResponseVersion | null> {
    const path = pathFor(cwd);
    return withFileWriteLock(path, async () => {
      const document = validDocument(await readJson<ResponseVersionDocument>(path, emptyDocument()));
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
