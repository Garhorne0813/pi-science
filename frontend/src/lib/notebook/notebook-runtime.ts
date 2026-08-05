import { kernelShutdownUrl } from "../../components/notebook/notebook-model";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export interface CellResult {
  ok: boolean;
  stdout: string;
  result: string | null;
  error: string | null;
}

export interface NotebookSaveRequest {
  session_id: string;
  message_id: string;
  source_line?: number;
  language: "python";
  code: string;
  result?: CellResult;
  model_at_save?: string;
  /** Assistant message timestamp; carried for provenance (server ignores
   *  unknown body fields, so this is a forward-compatible channel). */
  message_timestamp?: string;
}

export interface NotebookSaveResponse {
  ok: boolean;
  path: string;
  created_notebook: boolean;
  appended: boolean;
  updated: boolean;
  cell_index: number;
  cell_count: number;
  revision: number;
}

export interface KernelCapabilities {
  python: boolean;
  r: boolean;
}

export const notebookRuntime = {
  async capabilities(): Promise<KernelCapabilities> {
    const data = await queryClient.fetchQuery({
      queryKey: ["kernels", "status"],
      queryFn: () => apiRequest<{ interpreters?: Partial<KernelCapabilities> }>("/api/kernels/status", { errorFallback: "Unable to inspect kernels" }),
      staleTime: 0,
    });
    return { python: Boolean(data.interpreters?.python), r: Boolean(data.interpreters?.r) };
  },

  /** Cell execution is a mutation with side effects in the kernel — never cached. */
  async execute(notebookId: string, cwd: string, language: "python" | "r", code: string): Promise<CellResult> {
    const query = new URLSearchParams({ cwd });
    return apiRequest<CellResult>(`/api/kernels/execute?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, code, notebook_id: notebookId }),
      errorFallback: "Cell execution failed",
    });
  },

  async release(notebookId: string, cwd: string): Promise<void> {
    await apiRequest(kernelShutdownUrl(notebookId, cwd), { method: "POST" });
  },

  /** Persist a chat code block into the session notebook artifact. The server
   *  is idempotent per (session, message, source_line); a repeat save updates
   *  the existing cell instead of appending. Always a mutation — the query
   *  cache is invalidated so notebook listings refetch. */
  async saveChatCell(cwd: string, request: NotebookSaveRequest): Promise<NotebookSaveResponse> {
    const query = new URLSearchParams({ cwd });
    const data = await apiRequest<NotebookSaveResponse>(`/api/artifacts/notebooks/save?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      errorFallback: "Unable to save code to notebook",
    });
    queryClient.invalidateQueries({ queryKey: ["notebooks", cwd] });
    return data;
  },
};
