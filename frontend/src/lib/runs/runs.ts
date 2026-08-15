import type { ExecutionRecord } from "../../types/thread";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export const runsKey = (...selector: string[]) => ["runs", ...selector];

const refreshInterval = (query: { state: { data?: ExecutionRecord[] } }) =>
  query.state.data?.some((run) => run.status === "pending" || run.status === "running") ? 5_000 : 30_000;

// Runs are appended while the agent works, so this was never cached and stays uncached.
export const runsQuery = (cwd: string) => ({
  queryKey: runsKey(cwd),
  queryFn: async () => {
    const data = await apiRequest<{ executions?: ExecutionRecord[] }>(`/api/executions?${new URLSearchParams({ cwd })}`);
    return data.executions ?? [];
  },
  staleTime: 0,
  refetchInterval: refreshInterval,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});

export const sessionRunsQuery = (cwd: string, sessionId: string) => ({
  queryKey: runsKey(cwd, "session", sessionId),
  queryFn: async () => {
    const params = new URLSearchParams({ cwd, session_id: sessionId });
    const data = await apiRequest<{ executions?: ExecutionRecord[] }>(`/api/executions?${params}`);
    return data.executions ?? [];
  },
  staleTime: 0,
  refetchInterval: refreshInterval,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});

export const runLogQuery = (cwd: string, executionId: string) => ({
  queryKey: runsKey(cwd, executionId, "log"),
  queryFn: () => apiRequest<{ stdout?: string; stderr?: string; source?: "job" | "preview"; complete?: boolean }>(`/api/executions/${executionId}/logs?cwd=${encodeURIComponent(cwd)}`),
  staleTime: 0,
});

export async function loadRuns(sessionId: string, cwd = "."): Promise<ExecutionRecord[]> {
  const runs = await listRuns(cwd);
  return runs.filter((run) => run.correlation.session_id === sessionId);
}

/** Best-effort read for inspectors: an unreachable run store shows as "no runs". */
export async function listRuns(cwd: string): Promise<ExecutionRecord[]> {
  try {
    return await queryClient.fetchQuery(runsQuery(cwd));
  } catch {
    return [];
  }
}

export function reproduceRunPrompt(run: ExecutionRecord): string {
  const command = run.request.command?.length ? `\n\nRecorded command:\n\`\`\`sh\n${run.request.command.join(" ")}\n\`\`\`` : "";
  return (
    `Reproduce execution \`${run.execution_id}\`. Re-run it in the current workspace, ` +
    `compare all recorded outputs with the current files, and summarize any differences.${command}`
  );
}
