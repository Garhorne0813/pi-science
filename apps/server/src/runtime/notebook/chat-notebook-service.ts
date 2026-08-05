/** Notebook artifact persistence for conversation code cells.
 *
 *  Save-to-notebook (Notebook MVP 1, server side): a fixed, deterministic
 *  workspace path per session (`notebooks/chat-<session-id>-analysis.ipynb`),
 *  appending one provenance-markdown cell + one python-code cell per saved
 *  code block. Saving the same source again updates the existing code cell
 *  outputs (and its provenance cell) instead of duplicating the cells; the
 *  source key is a hash of session + message + source line + code digest.
 *  Cell results are translated into Jupyter outputs (stream / execute_result
 *  / error). Nothing here spawns the Python runtime: the caller decides
 *  whether to capture an execution result. */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceFile } from "../../security/workspace-security.js";
import { withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";
import type { SessionRepository } from "../node/session-repository.js";
import { sessionRepository } from "../node/session-repository.js";

export const MAX_CODE_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

export interface ChatCellResult {
  ok: boolean;
  stdout: string;
  result: string | null;
  error: string | null;
}

export interface ChatSaveRequest {
  session_id: string;
  message_id: string;
  source_line?: string;
  language?: string;
  code: string;
  result?: ChatCellResult | null;
  model_at_save?: string | null;
}

export interface ChatSaveSuccess {
  ok: true;
  path: string;
  created_notebook: boolean;
  appended: boolean;
  updated: boolean;
  cell_index: number;
  cell_count: number;
}

export interface ChatSaveFailure {
  ok: false;
  code: string;
  error: string;
}

export type ChatSaveOutcome = ChatSaveSuccess | ChatSaveFailure;

interface PiScienceMetadata {
  source: "conversation";
  session_id: string;
  message_id: string;
  message_timestamp?: string | null;
  source_line?: string;
  saved_at: string;
  code_sha256: string;
  model_at_save?: string | null;
  source_key: string;
}

interface NotebookCell {
  /** Stable cell id (nbformat-valid, Jupyter >= 4.5) so re-runs and diffs
   *  can reference a cell without depending on list position. */
  id?: string;
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string[];
  execution_count?: number | null;
  outputs?: unknown[];
}

interface NotebookDocument {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

function fail(code: string, error: string): ChatSaveFailure {
  return { ok: false, code, error };
}

/** Split text into Jupyter source/output lines: every line keeps a trailing
 *  newline; a trailing empty segment from a final newline is dropped so
 *  "a\n" stays ["a\n"] and "a\nb" stays ["a\n", "b\n"]. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => `${line}\n`);
}

function outputsFromResult(result: ChatCellResult): unknown[] {
  const outputs: unknown[] = [];
  if (result.stdout) {
    outputs.push({ output_type: "stream", name: "stdout", text: splitLines(result.stdout) });
  }
  if (result.result != null) {
    outputs.push({
      output_type: "execute_result",
      execution_count: null,
      data: { "text/plain": splitLines(result.result) },
      metadata: {},
    });
  }
  if (result.error) {
    const lines = result.error.split(/\r?\n/);
    // ename is the exception type: the first line up to the first colon
    // ("ValueError: bad value" -> "ValueError"), matching Jupyter output
    // conventions. evalue/traceback keep the full original text.
    const firstLine = lines.find((line) => line.length > 0) ?? "";
    const colon = firstLine.indexOf(":");
    const ename = (colon >= 0 ? firstLine.slice(0, colon) : firstLine).trim() || "Error";
    outputs.push({
      output_type: "error",
      ename,
      evalue: result.error,
      traceback: lines,
    });
  }
  return outputs;
}

/** A result payload counts as "present" only when it carries an explicit
 *  `ok` field. Callers may send `{}` or partial objects when no execution
 *  result was captured; those must NOT erase previously persisted outputs. */
function hasResultPayload(result: ChatCellResult | null | undefined): result is ChatCellResult {
  return result !== null && result !== undefined && typeof result === "object" && "ok" in result;
}

function provenanceMarkdownCell(meta: PiScienceMetadata): NotebookCell {
  const lines: string[] = [
    "# 💾 Saved from conversation",
    "",
    `- **Session**: \`${meta.session_id}\``,
    `- **Assistant message**: \`${meta.message_id}\``,
  ];
  if (meta.source_line) lines.push(`- **Source**: ${meta.source_line}`);
  lines.push(`- **Saved**: ${meta.saved_at}`);
  if (meta.model_at_save) lines.push(`- **Model at save**: ${meta.model_at_save}`);
  return {
    id: randomUUID(),
    cell_type: "markdown",
    metadata: { pi_science: meta },
    source: lines.map((line) => `${line}\n`),
  };
}

function codeCell(code: string, result: ChatCellResult | null, meta: PiScienceMetadata): NotebookCell {
  return {
    id: randomUUID(),
    cell_type: "code",
    execution_count: null,
    metadata: { pi_science: meta },
    source: splitLines(code),
    outputs: result ? outputsFromResult(result) : [],
  };
}

function sourceKeyOf(cell: NotebookCell): string | undefined {
  if (cell.cell_type !== "code") return undefined;
  const pi = cell.metadata?.pi_science as PiScienceMetadata | undefined;
  return pi?.source_key;
}

export class ChatNotebookService {
  constructor(private readonly repository: SessionRepository = sessionRepository) {}

  /** Persist one conversation code block into the session's notebook. */
  async save(cwd: string, request: ChatSaveRequest): Promise<ChatSaveOutcome> {
    if (!request.session_id || !request.message_id) return fail("invalid_request", "session_id and message_id are required");
    if (typeof request.code !== "string" || request.code.length === 0) return fail("invalid_request", "code is required");
    if (request.language !== undefined && request.language !== "python") return fail("invalid_request", "only python notebooks are supported");
    if (Buffer.byteLength(request.code, "utf8") > MAX_CODE_BYTES) return fail("code_too_large", "code exceeds the 1 MiB notebook cell limit");
    const serializedResult = request.result ? JSON.stringify(request.result) : "";
    if (Buffer.byteLength(serializedResult, "utf8") > MAX_RESULT_BYTES) return fail("result_too_large", "execution result exceeds the 2 MiB notebook limit");

    // Authoritative session/message validation from the persisted JSONL: the
    // client-supplied ids are only allowed when they resolve to an assistant
    // message that actually belongs to this workspace's session.
    const messages = await this.repository.messages(cwd, request.session_id);
    if (messages.length === 0) return fail("not_found", "session not found in this workspace");
    const message = messages.find((item) => item.id === request.message_id);
    if (!message || message.role !== "assistant") return fail("not_found", "assistant message not found in this session");

    const codeSha256 = createHash("sha256").update(request.code, "utf8").digest("hex");
    const sourceLine = request.source_line ?? "";
    const sourceKey = createHash("sha256")
      .update([request.session_id, request.message_id, sourceLine, codeSha256].join("\0"))
      .digest("hex");
    const relativePath = join("notebooks", `chat-${request.session_id}-analysis.ipynb`);
    let target: string;
    try {
      target = await resolveWorkspaceFile(cwd, relativePath);
    } catch (error) {
      return fail("workspace_invalid", String(error));
    }

    const savedAt = new Date().toISOString();
    const meta: PiScienceMetadata = {
      source: "conversation",
      session_id: request.session_id,
      message_id: request.message_id,
      message_timestamp: message.timestamp ?? null,
      source_line: sourceLine || undefined,
      saved_at: savedAt,
      code_sha256: codeSha256,
      model_at_save: request.model_at_save ?? null,
      source_key: sourceKey,
    };

    return withFileWriteLock(target, async () => {
      let notebook: NotebookDocument | null = null;
      let conflictError: string | null = null;
      let raw: string | null = null;
      try {
        raw = await readFile(target, "utf8");
      } catch (error) {
        // Only a missing file means "create fresh". A target that exists but
        // cannot be read (EACCES, EISDIR, ...) must surface as a clean 409
        // instead of being silently treated as absent or crashing later.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") conflictError = `existing notebook path is not readable: ${String(error)}`;
      }
      const exists = raw !== null;
      if (raw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          conflictError = `existing file is not a valid Jupyter notebook: ${String(error)}`;
        }
        const candidate = parsed as NotebookDocument | null;
        if (!conflictError && (!candidate || typeof candidate !== "object" || candidate.nbformat !== 4 || !Array.isArray(candidate.cells))) {
          conflictError = "existing file is not a valid Jupyter notebook";
        }
        notebook = candidate;
      }
      if (conflictError) return fail("conflict", conflictError);

      const createdNotebook = !exists || !notebook;
      if (!notebook) {
        notebook = {
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
            language_info: { name: "python", version: "3", mimetype: "text/x-python" },
            pi_science: { source: "conversation", session_id: request.session_id, created_at: savedAt },
          },
          cells: [],
        };
      }

      const existingIndex = notebook.cells.findIndex((cell) => sourceKeyOf(cell) === sourceKey);
      const provenance = provenanceMarkdownCell(meta);
      const code = codeCell(request.code, request.result ?? null, meta);

      if (existingIndex >= 0) {
        const previous = notebook.cells[existingIndex];
        if (previous) {
          // A payload without an explicit `ok` field (null/undefined/{}) means
          // "no result captured": keep the previous outputs instead of erasing
          // them. Only an explicit ok field replaces the outputs.
          const outputs = hasResultPayload(request.result) ? outputsFromResult(request.result) : (previous.outputs ?? []);
          notebook.cells[existingIndex] = {
            ...previous,
            outputs,
            metadata: { ...previous.metadata, pi_science: meta },
          };
        }
        // Refresh the provenance cell that precedes this code cell.
        for (let i = existingIndex - 1; i >= 0; i -= 1) {
          const cell = notebook.cells[i];
          if (!cell) break;
          if (cell.cell_type === "markdown" && (cell.metadata?.pi_science as PiScienceMetadata | undefined)?.source_key === sourceKey) {
            notebook.cells[i] = {
              ...cell,
              source: provenance.source,
              metadata: { ...cell.metadata, pi_science: meta },
            };
            break;
          }
          if (cell.cell_type === "code") break;
        }
        // Atomic write: temp file + rename so a crash mid-write can never
        // leave a truncated notebook at the target path.
        await writeJsonAtomic(target, notebook);
        return {
          ok: true,
          path: relativePath.replaceAll("\\", "/"),
          created_notebook: createdNotebook,
          appended: false,
          updated: true,
          cell_index: existingIndex,
          cell_count: notebook.cells.length,
        };
      }

      const cellIndex = notebook.cells.length;
      notebook.cells.push(provenance, code);
      await writeJsonAtomic(target, notebook);
      return {
        ok: true,
        path: relativePath.replaceAll("\\", "/"),
        created_notebook: createdNotebook,
        appended: true,
        updated: false,
        cell_index: cellIndex,
        cell_count: notebook.cells.length,
      };
    });
  }
}

export const chatNotebookService = new ChatNotebookService();
