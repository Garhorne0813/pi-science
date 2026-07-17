import type { ProvenanceRecord } from "../types/thread";

const API = "/api/provenance";

/** Load all provenance records for a session. */
export async function loadProvenance(cwd: string, sessionId: string): Promise<ProvenanceRecord[]> {
  try {
    const params = new URLSearchParams({ cwd, session_id: sessionId, limit: "200" });
    const res = await fetch(`${API}?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.records ?? [];
  } catch {
    return [];
  }
}

/** List all recorded versions of a file. */
export async function listProvenance(cwd: string, path: string): Promise<ProvenanceRecord[]> {
  try {
    const params = new URLSearchParams({ cwd });
    const res = await fetch(`${API}/versions/${encodeURIComponent(path)}?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.versions ?? [];
  } catch {
    return [];
  }
}

/** Read an environment lockfile snapshot by its content hash. */
export async function readEnvLockfile(cwd: string, hash: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ cwd });
    const res = await fetch(`${API}/env/${encodeURIComponent(hash)}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.text ?? null;
  } catch {
    return null;
  }
}
