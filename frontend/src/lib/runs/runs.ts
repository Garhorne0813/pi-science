import type { ExecutionRecord } from "@pi-science/contracts";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export const runsKey = (...selector: string[]) => ["runs", ...selector];

const refreshInterval = (liveConnected: boolean): false | ((query: { state: { data?: ExecutionRecord[] } }) => number) => {
  if (liveConnected) return false;
  return (query) => query.state.data?.some((run) => run.status === "pending" || run.status === "running") ? 5_000 : 30_000;
};

async function parseExecutionList(payload: unknown): Promise<ExecutionRecord[]> {
  // Keep Zod out of the initial conversation bundle; Runs is a lazy surface.
  const { executionListResponseSchema } = await import("@pi-science/contracts");
  return executionListResponseSchema.parse(payload).executions;
}

// Runs are appended while the agent works, so this was never cached and stays uncached.
export const runsQuery = (cwd: string, liveConnected = false) => ({
  queryKey: runsKey(cwd),
  queryFn: async () => {
    return parseExecutionList(await apiRequest<unknown>(`/api/executions?${new URLSearchParams({ cwd })}`));
  },
  staleTime: 0,
  refetchInterval: refreshInterval(liveConnected),
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});

export const sessionRunsQuery = (cwd: string, sessionId: string, liveConnected = false) => ({
  queryKey: runsKey(cwd, "session", sessionId),
  queryFn: async () => {
    const params = new URLSearchParams({ cwd, session_id: sessionId });
    return parseExecutionList(await apiRequest<unknown>(`/api/executions?${params}`));
  },
  staleTime: 0,
  refetchInterval: refreshInterval(liveConnected),
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});

export const runLogQuery = (cwd: string, executionId: string) => ({
  queryKey: runsKey(cwd, executionId, "log"),
  queryFn: async () => {
    const { executionLogResponseSchema } = await import("@pi-science/contracts");
    return executionLogResponseSchema.parse(await apiRequest<unknown>(`/api/executions/${executionId}/logs?cwd=${encodeURIComponent(cwd)}`));
  },
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
