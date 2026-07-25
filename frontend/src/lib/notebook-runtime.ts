import { kernelShutdownUrl } from "../components/notebook/notebook-model";

export interface CellResult {
  ok: boolean;
  stdout: string;
  result: string | null;
  error: string | null;
}

export interface KernelCapabilities {
  python: boolean;
  r: boolean;
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { detail?: string; error?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || fallback);
  return payload;
}

export const notebookRuntime = {
  async capabilities(): Promise<KernelCapabilities> {
    const data = await responseJson<{ interpreters?: Partial<KernelCapabilities> }>(await fetch("/api/kernels/status"), "Unable to inspect kernels");
    return { python: Boolean(data.interpreters?.python), r: Boolean(data.interpreters?.r) };
  },

  async execute(notebookId: string, cwd: string, language: "python" | "r", code: string): Promise<CellResult> {
    const query = new URLSearchParams({ cwd });
    return responseJson<CellResult>(await fetch(`/api/kernels/execute?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, code, notebook_id: notebookId }),
    }), "Cell execution failed");
  },

  async release(notebookId: string, cwd: string): Promise<void> {
    await fetch(kernelShutdownUrl(notebookId, cwd), { method: "POST" });
  },
};
