/**
 * Pi tools for file-backed Jupyter notebooks.
 *
 * The extension deliberately stays thin: the Node control plane owns notebook
 * parsing, revision checks, provenance, kernels, and execution records. This
 * adapter only translates Pi tool calls into those APIs so the same state is
 * visible to the browser and to non-agent callers.
 */

const MAX_CELLS_PER_CALL = 50;
const MAX_SOURCE_CHARS = 30_000;
const MAX_OUTPUT_CHARS = 12_000;

const NOTEBOOK_READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", description: "Workspace-relative path to a .ipynb file" },
    cell_ids: { type: "array", maxItems: MAX_CELLS_PER_CALL, items: { type: "string" }, description: "Optional stable cell ids to select" },
    include_outputs: { type: "boolean", default: true, description: "Include bounded output previews" },
  },
};

const NOTEBOOK_EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "operations"],
  properties: {
    path: { type: "string", description: "Workspace-relative path to a .ipynb file" },
    expected_sha256: { type: "string", description: "Revision returned by notebook_read; prevents overwriting a newer edit" },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CELLS_PER_CALL,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["cell_id", "action", "source"],
            properties: {
              cell_id: { type: "string" },
              action: { type: "string", enum: ["replace_source"] },
              source: { type: "string" },
              cell_type: { type: "string", enum: ["code", "markdown", "raw"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["cell_id", "action"],
            properties: {
              cell_id: { type: "string" },
              action: { type: "string", enum: ["clear_outputs"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "source", "cell_type"],
            properties: {
              action: { type: "string", enum: ["insert_cell"] },
              cell_id: { type: "string" },
              before_cell_id: { type: "string" },
              source: { type: "string" },
              cell_type: { type: "string", enum: ["code", "markdown", "raw"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["cell_id", "action"],
            properties: {
              cell_id: { type: "string" },
              action: { type: "string", enum: ["delete_cell"] },
            },
          },
        ],
      },
    },
  },
};

const NOTEBOOK_RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "cell_ids"],
  properties: {
    path: { type: "string", description: "Workspace-relative path to a .ipynb file" },
    cell_ids: { type: "array", minItems: 1, maxItems: MAX_CELLS_PER_CALL, items: { type: "string" }, description: "Stable cell ids to execute, in order" },
    clean_kernel: { type: "boolean", default: false, description: "Restart the notebook kernel before executing" },
    continue_on_error: { type: "boolean", default: false, description: "Continue with later cells after a failed cell" },
    timeout_seconds: { type: "integer", minimum: 1, maximum: 600, default: 120 },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… [truncated]`;
}

function buildToolResult(message: string, details: Record<string, unknown>) {
  return { content: [{ type: "text", text: message }], details };
}

function errorToolResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return buildToolResult(`Notebook tool error: ${message}`, { error: message });
}

function backendBaseUrl(): string {
  return (process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function workspaceCwd(ctx: any): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.env.PI_WORKSPACE_DIR || process.cwd();
}

function sessionId(ctx: any): string | undefined {
  for (const candidate of [ctx?.sessionId, ctx?.session_id]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

async function requestJson<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${backendBaseUrl()}${path}`, { ...init, signal: signal ?? init.signal });
  const raw = await response.text();
  let payload: unknown = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch { payload = { error: raw }; }
  }
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `${response.status} ${response.statusText}`;
    const failure = new Error(message);
    (failure as Error & { status?: number }).status = response.status;
    throw failure;
  }
  return payload as T;
}

function documentQuery(cwd: string, path: string, includeOutputs: boolean): string {
  return new URLSearchParams({ cwd, path, include_outputs: includeOutputs ? "true" : "false" }).toString();
}

function sourceText(value: unknown): string {
  return Array.isArray(value) ? value.map((line) => String(line)).join("") : typeof value === "string" ? value : "";
}

function stableNotebookId(path: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `file-${(hash >>> 0).toString(16)}`;
}

function notebookDocument(payload: unknown): { path: string; sha256: string; document: Record<string, unknown> & { cells: Record<string, unknown>[] } } {
  if (!isRecord(payload) || typeof payload.path !== "string" || typeof payload.sha256 !== "string" || !isRecord(payload.document) || !Array.isArray(payload.document.cells)) {
    throw new Error("Control plane returned an invalid notebook document");
  }
  const cells = payload.document.cells.filter(isRecord);
  if (cells.length !== payload.document.cells.length) throw new Error("Control plane returned an invalid notebook cell");
  return { path: payload.path, sha256: payload.sha256, document: { ...payload.document, cells } };
}

function outputPreview(output: unknown): unknown {
  if (!isRecord(output)) return truncate(text(output), MAX_OUTPUT_CHARS);
  const preview: Record<string, unknown> = {};
  for (const key of ["output_type", "name", "ename", "evalue"]) if (output[key] !== undefined) preview[key] = output[key];
  if (output.text !== undefined) preview.text = truncate(sourceText(output.text), MAX_OUTPUT_CHARS);
  if (Array.isArray(output.traceback)) preview.traceback = truncate(output.traceback.map(String).join("\n"), MAX_OUTPUT_CHARS);
  if (isRecord(output.data)) {
    preview.data = Object.fromEntries(Object.entries(output.data).map(([key, value]) => [key, truncate(sourceText(value), MAX_OUTPUT_CHARS)]));
  }
  return preview;
}

function projectCell(cell: Record<string, unknown>, includeOutputs: boolean): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: text(cell.id),
    cell_type: text(cell.cell_type),
    source: truncate(sourceText(cell.source), MAX_SOURCE_CHARS),
    execution_count: cell.execution_count ?? null,
  };
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  projected.output_count = outputs.length || (typeof cell.output_count === "number" ? cell.output_count : 0);
  if (includeOutputs) projected.outputs = outputs.slice(0, 20).map(outputPreview);
  return projected;
}

function formatRead(payload: { path: string; sha256: string; cells: Record<string, unknown>[] }): string {
  const lines = [`Notebook: ${payload.path}`, `Revision: ${payload.sha256}`, `Cells: ${payload.cells.length}`];
  for (const [index, cell] of payload.cells.entries()) {
    lines.push(`\n[${index}] ${text(cell.id)} (${text(cell.cell_type)})`);
    lines.push(String(cell.source ?? ""));
    if (Array.isArray(cell.outputs) && cell.outputs.length > 0) lines.push(`Outputs: ${cell.outputs.length}`);
  }
  return lines.join("\n");
}

function notebookLanguage(document: Record<string, unknown>): "python" | "r" {
  const metadata = isRecord(document.metadata) ? document.metadata : {};
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {};
  const kernelspec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  const raw = text(languageInfo.name || kernelspec.language || kernelspec.name || "python").toLowerCase();
  if (raw === "r" || raw.startsWith("ir")) return "r";
  if (raw.includes("python")) return "python";
  throw new Error(`Unsupported notebook kernel language: ${raw}`);
}

function executionText(result: Record<string, unknown>, cellId: string): string {
  const executionId = text(result.execution_id || (isRecord(result.execution) ? result.execution.execution_id : ""));
  const status = text(result.status || (isRecord(result.execution) ? result.execution.status : "unknown"));
  const stdout = text(result.stdout || (isRecord(result.execution) && isRecord(result.execution.result) ? result.execution.result.stdout_preview : ""));
  const stderr = text(result.stderr || (isRecord(result.execution) && isRecord(result.execution.result) ? result.execution.result.stderr_preview : ""));
  return [`${cellId}: ${status}${executionId ? ` (${executionId})` : ""}`, stdout ? `stdout:\n${truncate(stdout, MAX_OUTPUT_CHARS)}` : "", stderr ? `stderr:\n${truncate(stderr, MAX_OUTPUT_CHARS)}` : ""].filter(Boolean).join("\n");
}

function executionFailed(result: Record<string, unknown>): boolean {
  if (result.ok === false) return true;
  const execution = isRecord(result.execution) ? result.execution : result;
  return ["failed", "cancelled", "interrupted"].includes(text(execution.status).toLowerCase());
}

export default function registerPiScienceNotebook(pi: any) {
  pi.registerTool({
    name: "notebook_read",
    label: "Read Notebook",
    description: "Inspect a file-backed .ipynb by stable cell id, returning source, execution metadata, a revision hash, and bounded output previews.",
    promptSnippet: "Read a .ipynb notebook before editing or running its cells",
    promptGuidelines: [
      "Use cell_ids when you only need a subset of a large notebook; outputs are bounded previews.",
      "Set include_outputs: false when source and cell identity are enough; this tool reads file-backed notebooks, not the transient session notebook.",
    ],
    parameters: NOTEBOOK_READ_SCHEMA,
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      try {
        if (!isRecord(params) || typeof params.path !== "string") throw new Error("path is required");
        const cwd = workspaceCwd(ctx);
        const includeOutputs = params.include_outputs !== false;
        const payload = notebookDocument(await requestJson(`/api/notebooks/document?${documentQuery(cwd, params.path, includeOutputs)}`, {}, signal));
        const selected = Array.isArray(params.cell_ids) && params.cell_ids.length > 0
          ? new Set(params.cell_ids.map(text))
          : undefined;
        const cells = payload.document.cells
          .filter((cell) => !selected || selected.has(text(cell.id)))
          .map((cell) => projectCell(cell, includeOutputs));
        if (selected && cells.length !== selected.size) throw new Error("One or more requested cell_ids were not found");
        return buildToolResult(formatRead({ path: payload.path, sha256: payload.sha256, cells }), { path: payload.path, sha256: payload.sha256, cells });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  });

  pi.registerTool({
    name: "notebook_edit",
    label: "Edit Notebook",
    description: "Apply revision-checked source or structural edits to a file-backed .ipynb; never executes code.",
    promptSnippet: "Apply precise source edits to notebook cells with revision protection",
    promptGuidelines: [
      "Pass the sha256 from notebook_read as expected_sha256; if the edit reports a conflict, reread before retrying.",
      "Use insert_cell with an optional before_cell_id or delete_cell for structural edits; use stable ids returned by notebook_read.",
    ],
    parameters: NOTEBOOK_EDIT_SCHEMA,
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      try {
        if (!isRecord(params) || typeof params.path !== "string" || !Array.isArray(params.operations)) throw new Error("path and operations are required");
        const cwd = workspaceCwd(ctx);
        let expectedSha = typeof params.expected_sha256 === "string" ? params.expected_sha256 : undefined;
        if (!expectedSha) {
          const current = notebookDocument(await requestJson(`/api/notebooks/document?${documentQuery(cwd, params.path, false)}`, {}, signal));
          expectedSha = current.sha256;
        }
        const body = {
          path: params.path,
          expected_sha256: expectedSha,
          operations: params.operations,
          ...(sessionId(ctx) ? { session_id: sessionId(ctx) } : {}),
        };
        const result = await requestJson<Record<string, unknown>>(`/api/notebooks/edit?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
        const changed = Array.isArray(result.changed_cell_ids) ? result.changed_cell_ids.map(text) : [];
        const stale = Array.isArray(result.stale_cell_ids) ? result.stale_cell_ids.map(text) : [];
        const inserted = Array.isArray(result.inserted_cell_ids) ? result.inserted_cell_ids.map(text) : [];
        const deleted = Array.isArray(result.deleted_cell_ids) ? result.deleted_cell_ids.map(text) : [];
        return buildToolResult(`Edited ${text(result.path || params.path)}: ${changed.join(", ")}. New revision: ${text(result.sha256)}${inserted.length ? `\nInserted: ${inserted.join(", ")}` : ""}${deleted.length ? `\nDeleted: ${deleted.join(", ")}` : ""}${stale.length ? `\nCleared stale outputs: ${stale.join(", ")}` : ""}`, { ...result, expected_sha256: expectedSha });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  });

  pi.registerTool({
    name: "notebook_run",
    label: "Run Notebook Cells",
    description: "Execute selected code cells in order through the persistent Node-owned kernel and return execution and artifact evidence.",
    promptSnippet: "Run selected notebook code cells in order through the persistent kernel",
    promptGuidelines: [
      "Pass cell_ids in the intended execution order; use continue_on_error only when later cells are independent of a failure.",
      "Use clean_kernel when the run must start from a fresh namespace; otherwise the existing kernel state is intentionally reused.",
    ],
    parameters: NOTEBOOK_RUN_SCHEMA,
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      try {
        if (!isRecord(params) || typeof params.path !== "string" || !Array.isArray(params.cell_ids) || params.cell_ids.length === 0) throw new Error("path and at least one cell_id are required");
        const cwd = workspaceCwd(ctx);
        const notebook = notebookDocument(await requestJson(`/api/notebooks/document?${documentQuery(cwd, params.path, false)}`, {}, signal));
        const requestedIds = params.cell_ids.map(text);
        const byId = new Map(notebook.document.cells.map((cell) => [text(cell.id), cell]));
        const cells = requestedIds.map((id) => {
          const cell = byId.get(id);
          if (!cell) throw new Error(`Notebook cell not found: ${id}`);
          if (text(cell.cell_type) !== "code") throw new Error(`Notebook cell ${id} is ${text(cell.cell_type)}, not code`);
          return cell;
        });
        const language = notebookLanguage(notebook.document);
        const notebookId = stableNotebookId(notebook.path);
        if (params.clean_kernel === true) {
          await requestJson(`/api/kernels/${encodeURIComponent(notebookId)}/shutdown?cwd=${encodeURIComponent(cwd)}&language=${language}`, { method: "POST" }, signal);
        }
        const results: Record<string, unknown>[] = [];
        for (const [index, cell] of cells.entries()) {
          const cellId = requestedIds[index]!;
          const result = await requestJson<Record<string, unknown>>(`/api/kernels/execute?cwd=${encodeURIComponent(cwd)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              language,
              code: sourceText(cell.source),
              notebook_id: notebookId,
              source: "agent",
              notebook_path: notebook.path,
              cell_id: cellId,
              timeout_seconds: typeof params.timeout_seconds === "number" ? params.timeout_seconds : 120,
              ...(sessionId(ctx) ? { session_id: sessionId(ctx) } : {}),
            }),
          }, signal);
          let execution = result;
          const executionId = typeof result.execution_id === "string" ? result.execution_id : undefined;
          if (executionId) {
            try { execution = await requestJson<Record<string, unknown>>(`/api/executions/${encodeURIComponent(executionId)}?cwd=${encodeURIComponent(cwd)}`, {}, signal); }
            catch { /* The kernel response remains useful if the record read races persistence. */ }
          }
          const combined = { ...result, execution };
          results.push({ cell_id: cellId, ...combined });
          if (executionFailed(combined) && params.continue_on_error !== true) break;
        }
        const message = [`Ran ${results.length}/${cells.length} cell(s) in ${notebook.path}.`, ...results.map((result) => executionText(result, text(result.cell_id)))].join("\n\n");
        return buildToolResult(message, { path: notebook.path, notebook_id: notebookId, language, results });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  });
}
