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
  const group = groups.find((candidate) => candidate.versions.some((version) => version.sessionId === sessionId));
  if (!group) return sessionId;
  const selected = group.versions.find((version) => version.id === group.selectedVersionId);
  return selected?.sessionId ?? group.versions.at(-1)?.sessionId ?? sessionId;
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
