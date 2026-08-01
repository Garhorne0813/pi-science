import type { ProvenanceRecord } from "../../types/thread";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

const API = "/api/provenance";

export const provenanceKey = (...selector: string[]) => ["provenance", ...selector];

// Provenance was never cached: a record is appended every time the agent writes a
// file, so a stale read is worse than a second request. staleTime 0 keeps that,
// while the shared cache still deduplicates concurrent reads and retries 5xx.
function read<T>(queryKey: string[], path: string): Promise<T> {
  return queryClient.fetchQuery({ queryKey, queryFn: () => apiRequest<T>(path), staleTime: 0 });
}

/** List all recorded versions of a file. */
export async function listProvenance(cwd: string, path: string): Promise<ProvenanceRecord[]> {
  try {
    const params = new URLSearchParams({ cwd });
    const data = await read<{ versions?: ProvenanceRecord[] }>(provenanceKey(cwd, "versions", path), `${API}/versions/${encodeURIComponent(path)}?${params}`);
    return data.versions ?? [];
  } catch {
    return [];
  }
}

/** Read an environment lockfile snapshot by its content hash. */
export async function readEnvLockfile(cwd: string, hash: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ cwd });
    const data = await read<{ text?: string }>(provenanceKey(cwd, "env", hash), `${API}/env/${encodeURIComponent(hash)}?${params}`);
    return data.text ?? null;
  } catch {
    return null;
  }
}
