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
