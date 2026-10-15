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
    return executionLogResponseSchema.parse(await apiRequest<unknown>(`/api/executions/${encodeURIComponent(executionId)}/logs?cwd=${encodeURIComponent(cwd)}`));
  },
  staleTime: 0,
});

export async function loadRuns(sessionId: string, cwd = "."): Promise<ExecutionRecord[]> {
  return queryClient.fetchQuery(sessionRunsQuery(cwd, sessionId));
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
  return (
    `Attempt to reproduce execution \`${run.execution_id}\`. This is an AI-assisted attempt, not a verified reproduction. ` +
    `Before executing, review the recorded code/command, check input hashes and artifact versions, ` +
    `and check environment availability and versions. Never execute truncated code or a command reconstructed by guessing. ` +
    `Explain missing conditions (including uncaptured kernel state or input versions) and ask for confirmation before re-running. ` +
    `Never infer dependencies from timing alone. Compare outputs and artifact hashes with the recorded evidence; ` +
    `report differences and verification limits.\n\nRecorded evidence:\n` +
    JSON.stringify({ request: run.request, inputs: run.files.read, artifacts: run.artifacts,
      runtime: run.runtime, result: run.result, outputs: run.files.written, correlation: run.correlation }, null, 2)
  );
}

export interface RunsFilters {
  session_id?: string;
  target_id?: string;
  search?: string;
  kind?: ExecutionRecord["kind"];
  status?: ExecutionRecord["status"];
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}

export const runsPageQuery = (cwd: string, filters: RunsFilters, liveConnected = false) => ({
  queryKey: runsKey(cwd, "page", JSON.stringify(filters)),
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const params = new URLSearchParams({ cwd });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const { executionListResponseSchema } = await import("@pi-science/contracts");
    return executionListResponseSchema.parse(await apiRequest<unknown>(`/api/executions?${params}`, { signal }));
  },
  staleTime: 0,
  refetchInterval: liveConnected ? false as const : (query: { state: { data?: { executions: ExecutionRecord[] } } }) =>
    query.state.data?.executions.some((run) => run.status === "pending" || run.status === "running") ? 5_000 : 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
});


export const runQuery = (cwd: string, executionId: string) => ({
  queryKey: runsKey(cwd, "record", executionId),
  queryFn: async () => {
    const { executionRecordSchema } = await import("@pi-science/contracts");
    return executionRecordSchema.parse(await apiRequest<unknown>(`/api/executions/${encodeURIComponent(executionId)}?${new URLSearchParams({ cwd })}`));
  },
  staleTime: 0,
  retry: false as const,
});
