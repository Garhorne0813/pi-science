import type { RunRecord } from "../../types/thread";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export const runsKey = (...selector: string[]) => ["runs", ...selector];

// Runs are appended while the agent works, so this was never cached and stays uncached.
export const runsQuery = (cwd: string) => ({
  queryKey: runsKey(cwd),
  queryFn: async () => {
    const data: unknown = await apiRequest<unknown>(`/api/runs?${new URLSearchParams({ cwd })}`);
    return Array.isArray(data) ? data as RunRecord[] : [];
  },
  staleTime: 0,
});

export const runLogQuery = (cwd: string, runId: string) => ({
  queryKey: runsKey(cwd, runId, "log"),
  queryFn: () => apiRequest<{ log?: string }>(`/api/runs/${runId}/log?cwd=${encodeURIComponent(cwd)}`),
  staleTime: 0,
});

export async function loadRuns(sessionId: string, cwd = "."): Promise<RunRecord[]> {
  const runs = await listRuns(cwd);
  return runs.filter((run) => run.sessionId === sessionId);
}

/** Best-effort read for inspectors: an unreachable run store shows as "no runs". */
export async function listRuns(cwd: string): Promise<RunRecord[]> {
  try {
    return await queryClient.fetchQuery(runsQuery(cwd));
  } catch {
    return [];
  }
}

export function reproduceRunPrompt(run: RunRecord): string {
  const command = run.command ? `\n\nRecorded command:\n\`\`\`sh\n${run.command}\n\`\`\`` : "";
  return (
    `Reproduce experiment run \`${run.runId}\`. Re-run it in the current workspace, ` +
    `compare all recorded outputs with the current files, and summarize any differences.${command}`
  );
}
