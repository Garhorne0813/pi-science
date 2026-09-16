export interface ResponseVersion {
  sessionId: string;
  userMessageId: string | null;
  message: string;
}

export interface ResponseVersionGroup {
  id: string;
  versions: ResponseVersion[];
}

const STORAGE_PREFIX = "pi-science:response-versions:";
const MAX_GROUPS = 100;

export function appendResponseVersion(
  groups: ResponseVersionGroup[],
  source: ResponseVersion,
  target: ResponseVersion,
): ResponseVersionGroup[] {
  const index = groups.findIndex((group) => group.versions.some((version) => (
    version.sessionId === source.sessionId && version.userMessageId === source.userMessageId
  )));
  if (index < 0) {
    return [...groups, { id: `${source.sessionId}:${source.userMessageId}`, versions: [source, target] }].slice(-MAX_GROUPS);
  }
  const group = groups[index]!;
  if (group.versions.some((version) => version.sessionId === target.sessionId)) return groups;
  const next = [...groups];
  next[index] = { ...group, versions: [...group.versions, target] };
  return next;
}

export function bindResponseVersionMessage(
  groups: ResponseVersionGroup[],
  sessionId: string,
  userMessageId: string,
  message: string,
): ResponseVersionGroup[] {
  let changed = false;
  const next = groups.map((group) => ({
    ...group,
    versions: group.versions.map((version) => {
      if (version.sessionId !== sessionId || version.userMessageId !== null || version.message !== message) return version;
      changed = true;
      return { ...version, userMessageId };
    }),
  }));
  return changed ? next : groups;
}

export function responseVersionGroup(
  groups: ResponseVersionGroup[],
  sessionId: string,
  userMessageId: string,
): ResponseVersionGroup | undefined {
  return groups.find((group) => group.versions.some((version) => (
    version.sessionId === sessionId && version.userMessageId === userMessageId
  )));
}

export function readResponseVersionGroups(cwd: string): ResponseVersionGroup[] {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${cwd}`) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate): ResponseVersionGroup[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const record = candidate as { id?: unknown; versions?: unknown };
      if (typeof record.id !== "string" || !Array.isArray(record.versions)) return [];
      const versions = record.versions.flatMap((item): ResponseVersion[] => {
        if (!item || typeof item !== "object") return [];
        const version = item as Record<string, unknown>;
        if (
          typeof version.sessionId !== "string"
          || (version.userMessageId !== null && typeof version.userMessageId !== "string")
          || typeof version.message !== "string"
        ) return [];
        return [{ sessionId: version.sessionId, userMessageId: version.userMessageId as string | null, message: version.message }];
      });
      return versions.length > 1 ? [{ id: record.id, versions }] : [];
    }).slice(-MAX_GROUPS);
  } catch {
    return [];
  }
}

export function writeResponseVersionGroups(cwd: string, groups: ResponseVersionGroup[]): void {
  try {
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${cwd}`, JSON.stringify(groups.slice(-MAX_GROUPS)));
  } catch {
    // Version switching remains available for the current render when storage
    // is unavailable (private browsing, quota, or embedded webviews).
  }
}
