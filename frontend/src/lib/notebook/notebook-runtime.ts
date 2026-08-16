import { kernelShutdownUrl } from "../../components/notebook/notebook-model";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export interface CellResult {
  ok: boolean;
  stdout: string;
  result: string | null;
  error: string | null;
  execution_id?: string;
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
  async execute(
    notebookId: string,
    cwd: string,
    language: "python" | "r",
    code: string,
    sessionId?: string,
    options: { source?: "agent" | "session_notebook" | "file_notebook" | "terminal"; notebookPath?: string; cellId?: string } = {},
  ): Promise<CellResult> {
    const query = new URLSearchParams({ cwd });
    return apiRequest<CellResult>(`/api/kernels/execute?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language,
        code,
        notebook_id: notebookId,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(options.source ? { source: options.source } : {}),
        ...(options.notebookPath ? { notebook_path: options.notebookPath } : {}),
        ...(options.cellId ? { cell_id: options.cellId } : {}),
      }),
      errorFallback: "Cell execution failed",
    });
  },

  async release(notebookId: string, cwd: string): Promise<void> {
    await apiRequest(kernelShutdownUrl(notebookId, cwd), { method: "POST" });
  },

  async interrupt(notebookId: string, cwd: string, language?: "python" | "r"): Promise<void> {
    const params = new URLSearchParams({ cwd, ...(language ? { language } : {}) });
    await apiRequest(`/api/kernels/${encodeURIComponent(notebookId)}/interrupt?${params}`, { method: "POST" });
  },
};
