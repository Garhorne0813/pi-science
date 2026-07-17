export interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCell {
  cell_type: "markdown" | "code" | "raw" | string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: NotebookOutput[];
}

export interface NotebookDocument {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: { language?: string; name?: string; display_name?: string };
    language_info?: { name?: string };
  };
}

export interface NotebookKernel {
  language: "python" | "r" | "unsupported";
  label: string;
}

export function parseNotebookDocument(raw: string): NotebookDocument {
  const notebook = JSON.parse(raw) as Partial<NotebookDocument>;
  if (!Array.isArray(notebook.cells)) throw new Error("Invalid notebook: cells array is missing");
  return notebook as NotebookDocument;
}

export function notebookKernel(notebook: NotebookDocument): NotebookKernel {
  const rawLanguage = (
    notebook.metadata?.language_info?.name
    || notebook.metadata?.kernelspec?.language
    || notebook.metadata?.kernelspec?.name
    || "python"
  ).toLowerCase();
  const displayName = notebook.metadata?.kernelspec?.display_name;
  if (rawLanguage === "r" || rawLanguage.startsWith("ir")) {
    return { language: "r", label: displayName || "R" };
  }
  if (rawLanguage.includes("python")) {
    return { language: "python", label: displayName || "Python" };
  }
  return { language: "unsupported", label: displayName || rawLanguage || "Unknown kernel" };
}

export function sourceText(source: string | string[] | undefined): string {
  return Array.isArray(source) ? source.join("") : source || "";
}

export function outputText(output: NotebookOutput): string {
  if (output.output_type === "error") {
    return output.traceback?.join("\n") || [output.ename, output.evalue].filter(Boolean).join(": ");
  }
  const direct = sourceText(output.text);
  if (direct) return direct;
  const plain = output.data?.["text/plain"];
  return Array.isArray(plain) ? plain.join("") : plain || "";
}

export function stableNotebookId(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `file-${(hash >>> 0).toString(16)}`;
}

export function kernelShutdownUrl(notebookId: string, cwd: string): string {
  const params = new URLSearchParams({ cwd });
  return `/api/kernels/${encodeURIComponent(notebookId)}/shutdown?${params}`;
}
