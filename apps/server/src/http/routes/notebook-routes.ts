import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { resolveWorkspaceFile, validateWorkspaceCwd } from "../../security/workspace-security.js";
import { withFileWriteLock } from "../../storage/persistence.js";
import { recordProvenance } from "./artifact-routes.js";
import type { NotebookService } from "../../runtime/notebooks/notebook-service.js";
import {
  applyNotebookEdits,
  normalizeNotebookDocument,
  notebookSha256,
  notebookSourceText,
  parseNotebookDocument,
  serializeNotebookDocument,
  type NotebookCellDocument,
  type NotebookEditOperation,
  type NotebookDocument,
} from "../../runtime/notebooks/notebook-document.js";

const MAX_NOTEBOOK_BYTES = 50 * 1024 * 1024;
const MAX_OUTPUT_PREVIEW_CHARS = 16 * 1024;
const MAX_OUTPUTS_PER_CELL = 20;

async function cwdFromQuery(query: { cwd?: unknown }, fallback = "."): Promise<string> {
  const value = query.cwd ?? fallback;
  return validateWorkspaceCwd(String(value));
}

function notebookPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Notebook path is required");
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized.toLowerCase().endsWith(".ipynb")) throw new Error("Notebook path must point to a .ipynb file");
  return normalized;
}

function relativeNotebookPath(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function truncateOutput(value: string): string {
  return value.length <= MAX_OUTPUT_PREVIEW_CHARS ? value : `${value.slice(0, MAX_OUTPUT_PREVIEW_CHARS)}\n… [truncated]`;
}

function boundedNotebookOutput(output: unknown): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return typeof output === "string" ? truncateOutput(output) : output;
  const bounded = { ...(output as Record<string, unknown>) };
  if (bounded.text !== undefined) bounded.text = truncateOutput(notebookSourceText(bounded.text));
  if (Array.isArray(bounded.traceback)) bounded.traceback = [truncateOutput(bounded.traceback.map(String).join("\n"))];
  if (bounded.data && typeof bounded.data === "object" && !Array.isArray(bounded.data)) {
    bounded.data = Object.fromEntries(Object.entries(bounded.data as Record<string, unknown>).map(([key, value]) => [key, truncateOutput(notebookSourceText(value))]));
  }
  return bounded;
}

function responseDocument(document: NotebookDocument, includeOutputs: boolean): NotebookDocument {
  return {
    ...document,
    cells: document.cells.map((cell) => {
      const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
      const responseCell: NotebookCellDocument = { ...cell, output_count: outputs.length };
      if (includeOutputs) responseCell.outputs = outputs.slice(0, MAX_OUTPUTS_PER_CELL).map(boundedNotebookOutput);
      else delete responseCell.outputs;
      return responseCell;
    }),
  };
}

async function readNotebook(root: string, requestedPath: string): Promise<{
  target: string;
  path: string;
  raw: string;
  document: NotebookDocument;
  sha256: string;
}> {
  const target = await resolveWorkspaceFile(root, requestedPath);
  const metadata = await stat(target);
  if (!metadata.isFile()) throw new Error(`Notebook path is not a file: ${requestedPath}`);
  if (metadata.size > MAX_NOTEBOOK_BYTES) throw new Error(`Notebook is too large to read (${metadata.size} bytes)`);
  const raw = await readFile(target, "utf8");
  const path = relativeNotebookPath(root, target);
  const document = normalizeNotebookDocument(parseNotebookDocument(raw), path);
  return { target, path, raw, document, sha256: notebookSha256(raw) };
}

function parseNotebookEditOperations(value: unknown): NotebookEditOperation[] {
  if (!Array.isArray(value)) throw new Error("operations must be an array");
  return value.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error(`Invalid notebook edit at index ${index}`);
    const operation = candidate as Record<string, unknown>;
    const action = operation.action;
    if (operation.action === "replace_source" && typeof operation.source === "string") {
      if (typeof operation.cell_id !== "string" || !operation.cell_id.trim()) throw new Error(`Notebook edit ${index} requires cell_id`);
      if (operation.cell_type !== undefined && (typeof operation.cell_type !== "string" || !["code", "markdown", "raw"].includes(operation.cell_type))) throw new Error(`Invalid cell_type at notebook edit ${index}`);
      return { cell_id: operation.cell_id, action: "replace_source", source: operation.source, ...(typeof operation.cell_type === "string" ? { cell_type: operation.cell_type } : {}) };
    }
    if (action === "clear_outputs" && typeof operation.cell_id === "string" && operation.cell_id.trim()) return { cell_id: operation.cell_id, action: "clear_outputs" };
    if (action === "delete_cell" && typeof operation.cell_id === "string" && operation.cell_id.trim()) return { cell_id: operation.cell_id, action: "delete_cell" };
    if (action === "insert_cell" && typeof operation.source === "string" && typeof operation.cell_type === "string" && ["code", "markdown", "raw"].includes(operation.cell_type)) {
      if (operation.cell_id !== undefined && (typeof operation.cell_id !== "string" || !operation.cell_id.trim())) throw new Error(`Invalid inserted cell_id at notebook edit ${index}`);
      if (operation.before_cell_id !== undefined && (typeof operation.before_cell_id !== "string" || !operation.before_cell_id.trim())) throw new Error(`Invalid before_cell_id at notebook edit ${index}`);
      return {
        action: "insert_cell",
        source: operation.source,
        cell_type: operation.cell_type,
        ...(typeof operation.cell_id === "string" ? { cell_id: operation.cell_id } : {}),
        ...(typeof operation.before_cell_id === "string" ? { before_cell_id: operation.before_cell_id } : {}),
      };
    }
    throw new Error(`Unsupported notebook edit action at index ${index}`);
  });
}

class NotebookRevisionConflict extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super("Notebook changed since it was read");
    this.name = "NotebookRevisionConflict";
  }
}

async function writeNotebookAtomically(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function registerNotebookRoutes(app: FastifyInstance, notebooks: NotebookService): void {
  app.get("/api/notebooks/document", async (request, reply) => {
    const query = request.query as { cwd?: unknown; path?: unknown; include_outputs?: unknown };
    let root: string;
    let path: string;
    try {
      root = await cwdFromQuery(query);
      path = notebookPath(query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    try {
      const notebook = await readNotebook(root, path);
      return {
        path: notebook.path,
        sha256: notebook.sha256,
        document: responseDocument(notebook.document, query.include_outputs !== "false" && query.include_outputs !== "0"),
      };
    } catch (error) {
      if (error instanceof Error && /escapes the workspace|must be relative|metadata paths/i.test(error.message)) {
        return reply.code(403).send({ error: error.message });
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: `Notebook not found: ${path}` });
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/notebooks/edit", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    let root: string;
    let path: string;
    let operations: NotebookEditOperation[];
    try {
      root = await cwdFromQuery(request.query as { cwd?: unknown });
      path = notebookPath(body.path);
      operations = parseNotebookEditOperations(body.operations);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const expectedSha = body.expected_sha256 === undefined ? undefined : String(body.expected_sha256);
    if (expectedSha !== undefined && !/^[0-9a-f]{64}$/i.test(expectedSha)) return reply.code(400).send({ error: "expected_sha256 must be a SHA-256 hex digest" });

    try {
      const target = await resolveWorkspaceFile(root, path);
      const result = await withFileWriteLock(target, async () => {
        const metadata = await stat(target);
        if (!metadata.isFile()) throw new Error(`Notebook path is not a file: ${path}`);
        if (metadata.size > MAX_NOTEBOOK_BYTES) throw new Error(`Notebook is too large to edit (${metadata.size} bytes)`);
        const raw = await readFile(target, "utf8");
        const actualSha = notebookSha256(raw);
        if (expectedSha && expectedSha.toLowerCase() !== actualSha) throw new NotebookRevisionConflict(expectedSha, actualSha);
        const normalized = normalizeNotebookDocument(parseNotebookDocument(raw), relativeNotebookPath(root, target));
        const applied = applyNotebookEdits(normalized, operations);
        const serialized = serializeNotebookDocument(applied.document);
        await writeNotebookAtomically(target, serialized);
        return { ...applied, path: relativeNotebookPath(root, target), sha256: notebookSha256(serialized), serialized };
      });
      await recordProvenance(root, {
        path: result.path,
        tool: "notebook_edit",
        session_id: typeof body.session_id === "string" ? body.session_id : "",
        content: result.serialized,
        diff: `changed cells: ${result.changed_cell_ids.join(", ")}`,
      });
      return {
        ok: true,
        path: result.path,
        sha256: result.sha256,
        changed_cell_ids: result.changed_cell_ids,
        stale_cell_ids: result.stale_cell_ids,
        inserted_cell_ids: result.inserted_cell_ids,
        deleted_cell_ids: result.deleted_cell_ids,
      };
    } catch (error) {
      if (error instanceof NotebookRevisionConflict) {
        return reply.code(409).send({ error: error.message, expected_sha256: error.expected, actual_sha256: error.actual });
      }
      if (error instanceof Error && /escapes the workspace|must be relative|metadata paths/i.test(error.message)) {
        return reply.code(403).send({ error: error.message });
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: `Notebook not found: ${path}` });
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notebooks", async (request, reply) => {
    try {
      const cwd = await cwdFromQuery(request.query as { cwd?: unknown });
      return await notebooks.list(cwd);
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notebooks/jupyter/env-status", async (request, reply) => {
    try {
      const cwd = await cwdFromQuery(request.query as { cwd?: unknown });
      return await notebooks.envStatus(cwd);
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notebooks/jupyter/status", async (request, reply) => {
    try {
      const query = request.query as { cwd?: unknown };
      const cwd = query.cwd === undefined ? undefined : await cwdFromQuery(query, ".");
      const payload = notebooks.status(cwd);
      if (cwd !== undefined) payload.env_ready = (await notebooks.envStatus(cwd)).ready;
      return payload;
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/notebooks/jupyter/setup", async (request, reply) => {
    let cwd: string;
    try { cwd = await cwdFromQuery(request.query as { cwd?: unknown }); }
    catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) }); }
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const write = (event: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await notebooks.setup(cwd, write);
    } catch (error) {
      write({ status: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
    return reply;
  });

  app.post("/api/notebooks/jupyter/start", async (request, reply) => {
    try {
      const cwd = await cwdFromQuery(request.query as { cwd?: unknown });
      return await notebooks.start(cwd);
    } catch (error) {
      return reply.code(error instanceof Error && /already running/i.test(error.message) ? 409 : 400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/notebooks/jupyter/stop", async (request, reply) => {
    try {
      const query = request.query as { cwd?: unknown };
      const cwd = query.cwd === undefined ? undefined : await cwdFromQuery(query, ".");
      return notebooks.stop(cwd);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
