import { apiRequest } from "../client/api";

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
  rootSessionId?: string;
  sourceSessionId?: string;
  sourceUserMessageId?: string;
  versions: ResponseVersion[];
  selectedVersionId?: string;
  updatedAt?: string;
}

export function responseVersionGroup(groups: ResponseVersionGroup[], sessionId: string, userMessageId: string): ResponseVersionGroup | undefined {
  return groups.find((group) => group.versions.some((version) => version.sessionId === sessionId && version.userMessageId === userMessageId));
}

export function bindResponseVersionMessage(groups: ResponseVersionGroup[], versionId: string, userMessageId: string): ResponseVersionGroup[] {
  let changed = false;
  const next = groups.map((group) => ({
    ...group,
    versions: group.versions.map((version) => {
      if (version.id !== versionId || version.userMessageId === userMessageId) return version;
      changed = true;
      return { ...version, userMessageId };
    }),
  }));
  return changed ? next : groups;
}

export function preferredResponseVersionSession(groups: ResponseVersionGroup[], sessionId: string): string {
  let current = sessionId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const candidates = groups.filter((group) => (group.sourceSessionId ?? group.versions[0]?.sessionId) === current);
    const group = candidates.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];
    if (!group) break;
    const selected = group.selectedVersionId
      ? group.versions.find((version) => version.id === group.selectedVersionId && version.status !== "failed")
      : group.versions.findLast((version) => version.status !== "failed");
    if (!selected || selected.sessionId === current) break;
    current = selected.sessionId;
  }
  return current;
}

export function responseVersionRootSession(groups: ResponseVersionGroup[], sessionId: string): string {
  const explicit = groups.find((group) => (
    group.rootSessionId === sessionId || group.versions.some((version) => version.sessionId === sessionId)
  ))?.rootSessionId;
  if (explicit) return explicit;
  let current = sessionId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const parent = groups.find((group) => (
      (group.sourceSessionId ?? group.versions[0]?.sessionId) !== current
      && group.versions.some((version) => version.sessionId === current)
    ));
    if (!parent) break;
    current = parent.sourceSessionId ?? parent.versions[0]?.sessionId ?? current;
  }
  return current;
}

export async function fetchResponseVersionGroups(cwd: string, sessionId?: string): Promise<ResponseVersionGroup[]> {
  const params = new URLSearchParams({ cwd });
  if (sessionId) params.set("session_id", sessionId);
  const result = await apiRequest<{ groups?: ResponseVersionGroup[] }>(`/api/response-versions?${params}`);
  return Array.isArray(result.groups) ? result.groups : [];
}

export async function persistResponseVersionMessage(cwd: string, versionId: string, userMessageId: string): Promise<void> {
  await apiRequest(`/api/response-versions/${encodeURIComponent(versionId)}/message?${new URLSearchParams({ cwd })}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_message_id: userMessageId }),
  });
}

export async function persistSelectedResponseVersion(cwd: string, versionId: string): Promise<void> {
  await apiRequest(`/api/response-versions/${encodeURIComponent(versionId)}/selected?${new URLSearchParams({ cwd })}`, {
    method: "PUT",
  });
}
