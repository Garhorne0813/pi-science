export interface ProvenanceRecord {
  path: string; version: number; ts: number; tool: string;
  toolCallId?: string; sessionId: string; model?: string;
  contentHash?: string; diff?: string; runId?: string;
  env?: Record<string, unknown>;
}
export async function loadProvenance(sessionId: string): Promise<ProvenanceRecord[]> { return []; }

export async function listProvenance(sessionId: string): Promise<ProvenanceRecord[]> {
  return [];
}

export async function readEnvLockfile(sessionId: string, hash: string): Promise<string | null> {
  return null;
}
