export interface RunRecord {
  runId: string;
  command?: string;
  surface: "local" | "hpc" | "ssh";
  status: "ok" | "failed" | "running";
  host?: string;
  startedAt?: string;
  endedAt?: string;
  outputs?: { path: string; hash?: string; size?: number }[];
  code?: string[];
  envFile?: string;
}
export async function loadRuns(sessionId: string): Promise<RunRecord[]> { return []; }

export async function listRuns(cwd: string): Promise<RunRecord[]> {
  return [];
}

export function reproduceRunPrompt(run: RunRecord): string {
  return `Reproduce run: ${run.runId}`;
}
