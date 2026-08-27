import { kernelShutdownUrl } from "../../components/notebook/notebook-model";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export interface CellResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
  result: string | null;
  error: string | null;
  interrupted?: boolean;
  mime?: Record<string, string>;
  execution_id?: string;
}

export interface KernelCapabilities {
  python: boolean;
  r: boolean;
}

export type KernelStreamEvent =
  | { type: "started"; execution_id: string }
  | { type: "stream"; stream: "stdout" | "stderr"; text: string };

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
      credentials: "include",
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

  async executeStreaming(
    notebookId: string,
    cwd: string,
    language: "python" | "r",
    code: string,
    sessionId: string | undefined,
    options: { source?: "agent" | "session_notebook" | "file_notebook" | "terminal"; notebookPath?: string; cellId?: string } = {},
    onEvent?: (event: KernelStreamEvent) => void,
  ): Promise<CellResult> {
    const response = await fetch(`/api/kernels/execute-stream?${new URLSearchParams({ cwd })}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language, code, notebook_id: notebookId,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(options.source ? { source: options.source } : {}),
        ...(options.notebookPath ? { notebook_path: options.notebookPath } : {}),
        ...(options.cellId ? { cell_id: options.cellId } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      let message = "Cell execution failed";
      try { const body = await response.json() as { error?: string; detail?: string }; message = body.error || body.detail || message; } catch { /* keep fallback */ }
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: CellResult | null = null;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as KernelStreamEvent | (CellResult & { type: "result" });
      if (event.type === "result") result = event;
      else onEvent?.(event);
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consume);
      if (done) break;
    }
    consume(buffer);
    if (!result) throw new Error("Kernel stream ended without a result");
    return result;
  },

  async release(notebookId: string, cwd: string): Promise<void> {
    await apiRequest(kernelShutdownUrl(notebookId, cwd), { method: "POST" });
  },

  async interrupt(notebookId: string, cwd: string, language?: "python" | "r"): Promise<void> {
    const params = new URLSearchParams({ cwd, ...(language ? { language } : {}) });
    await apiRequest(`/api/kernels/${encodeURIComponent(notebookId)}/interrupt?${params}`, { method: "POST" });
  },
};
