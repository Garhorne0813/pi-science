import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatNotebookService, MAX_CODE_BYTES, MAX_RESULT_BYTES } from "./chat-notebook-service.js";
import { ensureProject } from "../../project/project-registry.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-notebook-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, ".pi-science", "sessions"), { recursive: true });
  await ensureProject(cwd);
  return cwd;
}

function sessionHeader(id: string, cwd: string) {
  return `${JSON.stringify({ type: "session", id, cwd, timestamp: "2026-08-01T00:00:00.000Z" })}\n`;
}

function messageLine(id: string, role: string, text: string, timestamp = "2026-08-01T00:00:01.000Z") {
  return `${JSON.stringify({ type: "message", id, timestamp, message: { role, content: [{ type: "text", text }] } })}\n`;
}

const SESSION = "019f0000-0000-7000-8000-000000000001";
const ASSISTANT = "msg-assistant-1";
const ASSISTANT_2 = "msg-assistant-2";
const USER = "msg-user-1";

async function writeSession(cwd: string): Promise<void> {
  await writeFile(
    join(cwd, ".pi-science", "sessions", "session-a.jsonl"),
    sessionHeader(SESSION, cwd) + messageLine(USER, "user", "请分析数据") + messageLine(ASSISTANT, "assistant", "好的，我来分析。") + messageLine(ASSISTANT_2, "assistant", "补充分析。"),
    "utf8",
  );
}

interface SavedNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: Array<{ id?: string; cell_type: string; metadata: Record<string, unknown>; source: string[]; outputs?: unknown[] }>;
}

async function readNotebook(cwd: string): Promise<SavedNotebook> {
  const raw = await readFile(join(cwd, "notebooks", `chat-${SESSION}-analysis.ipynb`), "utf8");
  return JSON.parse(raw) as SavedNotebook;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("ChatNotebookService", () => {
  it("creates a notebook on first save with provenance + code cells", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    const outcome = await service.save(cwd, {
      session_id: SESSION,
      message_id: ASSISTANT,
      source_line: "L12-L40",
      language: "python",
      code: "import pandas as pd\nprint(pd.__version__)\n",
      result: { ok: true, stdout: "2.2.0\n", result: null, error: null },
      model_at_save: "custom-gpt/gpt-5.6-luna",
    });

    expect(outcome).toMatchObject({ ok: true, created_notebook: true, appended: true, updated: false, cell_count: 2 });
    if (!outcome.ok) return;
    expect(outcome.path).toBe(`notebooks/chat-${SESSION}-analysis.ipynb`);
    expect(outcome.cell_index).toBe(0);

    const notebook = await readNotebook(cwd);
    expect(notebook.nbformat).toBe(4);
    expect(notebook.nbformat_minor).toBe(5);
    expect(notebook.metadata.kernelspec).toMatchObject({ name: "python3", language: "python" });
    expect(notebook.metadata.pi_science).toMatchObject({ source: "conversation", session_id: SESSION });
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[0]!.cell_type).toBe("markdown");
    expect(notebook.cells[0]!.id).toBeTruthy();
    expect(notebook.cells[1]!.id).toBeTruthy();
    expect(notebook.cells[0]!.source.join("")).toContain("Saved from conversation");
    expect(notebook.cells[0]!.source.join("")).toContain(SESSION);
    expect(notebook.cells[0]!.source.join("")).toContain(ASSISTANT);
    expect(notebook.cells[0]!.source.join("")).toContain("L12-L40");
    expect(notebook.cells[0]!.source.join("")).toContain("custom-gpt/gpt-5.6-luna");
    const pi = notebook.cells[0]!.metadata.pi_science as Record<string, unknown>;
    expect(pi).toMatchObject({ session_id: SESSION, message_id: ASSISTANT, source_line: "L12-L40" });
    expect(typeof pi.code_sha256).toBe("string");
    expect(typeof pi.source_key).toBe("string");
    expect(pi.source_key).toHaveLength(64);

    const code = notebook.cells[1]!;
    expect(code.cell_type).toBe("code");
    expect(code.source.join("")).toBe("import pandas as pd\nprint(pd.__version__)\n");
    expect(code.outputs).toEqual([{ output_type: "stream", name: "stdout", text: ["2.2.0\n"] }]);
  });

  it("appends new cells for a different source and keeps the notebook valid", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: { ok: true, stdout: "", result: "1", error: null } });
    const second = await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT_2, code: "y = 2\n", result: { ok: true, stdout: "", result: "2", error: null } });

    expect(second).toMatchObject({ ok: true, appended: true, updated: false, cell_count: 4 });
    const notebook = await readNotebook(cwd);
    expect(notebook.cells).toHaveLength(4);
    expect(notebook.cells.map((cell) => cell!.cell_type)).toEqual(["markdown", "code", "markdown", "code"]);
    expect(notebook.cells[3]!.source.join("")).toBe("y = 2\n");
  });

  it("updates the existing code cell instead of duplicating on the same source key", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    const first = await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: { ok: true, stdout: "", result: "1", error: null } });
    expect(first.ok && first.cell_count).toBe(2);
    const second = await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: { ok: true, stdout: "", result: "2", error: null } });

    expect(second).toMatchObject({ ok: true, appended: false, updated: true, cell_count: 2, cell_index: 1 });
    const notebook = await readNotebook(cwd);
    expect(notebook.cells).toHaveLength(2);
    const code = notebook.cells[1]!;
    expect(code.outputs).toEqual([{ output_type: "execute_result", execution_count: null, data: { "text/plain": ["2\n"] }, metadata: {} }]);
    // provenance cell refreshed with the newer saved_at
    expect(notebook.cells[0]!.metadata.pi_science).toMatchObject({ message_id: ASSISTANT });
  });

  it("keeps previous outputs when an update carries no result", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: { ok: true, stdout: "old stdout\n", result: null, error: null } });
    const second = await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n" });

    expect(second).toMatchObject({ ok: true, updated: true });
    const notebook = await readNotebook(cwd);
    expect(notebook.cells[1]!.outputs).toEqual([{ output_type: "stream", name: "stdout", text: ["old stdout\n"] }]);
  });

  it("keeps previous outputs when an update result payload lacks the explicit ok field", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: { ok: true, stdout: "old stdout\n", result: null, error: null } });
    // `{}` / partial objects without `ok` mean "no result captured": the
    // previous outputs must survive, not be erased by an empty translation.
    const second = await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: {} as never });

    expect(second).toMatchObject({ ok: true, updated: true });
    const notebook = await readNotebook(cwd);
    expect(notebook.cells[1]!.outputs).toEqual([{ output_type: "stream", name: "stdout", text: ["old stdout\n"] }]);
  });

  it("translates stdout, result and error outputs into Jupyter outputs", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "print(1)\n1 + 1", result: { ok: false, stdout: "print 1\n", result: "2", error: "TypeError: bad operand" } });

    const notebook = await readNotebook(cwd);
    const outputs = notebook.cells[1]!.outputs as Array<Record<string, unknown>>;
    expect(outputs).toEqual([
      { output_type: "stream", name: "stdout", text: ["print 1\n"] },
      { output_type: "execute_result", execution_count: null, data: { "text/plain": ["2\n"] }, metadata: {} },
      { output_type: "error", ename: "TypeError", evalue: "TypeError: bad operand", traceback: ["TypeError: bad operand"] },
    ]);
  });

  it("derives the error ename from the first line before the colon and keeps the traceback verbatim", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await service.save(cwd, {
      session_id: SESSION,
      message_id: ASSISTANT,
      code: "x = []\nx[0]\n",
      result: { ok: false, stdout: "", result: null, error: "IndexError: list index out of range\n    at <cell line 2>\n    at main()" },
    });

    const notebook = await readNotebook(cwd);
    const outputs = notebook.cells[1]!.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      output_type: "error",
      ename: "IndexError",
      evalue: "IndexError: list index out of range\n    at <cell line 2>\n    at main()",
      traceback: ["IndexError: list index out of range", "    at <cell line 2>", "    at main()"],
    });
  });

  it("preserves CJK code and results as UTF-8", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await service.save(cwd, {
      session_id: SESSION,
      message_id: ASSISTANT,
      code: "print('蛋白质工程')\n",
      result: { ok: true, stdout: "蛋白质工程\n", result: "中文结果：成功", error: null },
    });

    const notebook = await readNotebook(cwd);
    expect(notebook.cells[1]!.source.join("")).toContain("蛋白质工程");
    const outputs = notebook.cells[1]!.outputs as Array<Record<string, unknown>>;
    expect(JSON.stringify(outputs)).toContain("中文结果：成功");
    const raw = await readFile(join(cwd, "notebooks", `chat-${SESSION}-analysis.ipynb`), "utf8");
    expect(raw).toContain("蛋白质工程");
  });

  it("does not lose cells under concurrent saves", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await Promise.all([
      service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "a = 1\n" }),
      service.save(cwd, { session_id: SESSION, message_id: ASSISTANT_2, code: "b = 2\n" }),
    ]);

    const notebook = await readNotebook(cwd);
    expect(notebook.cells).toHaveLength(4);
    const sources = notebook.cells.filter((cell) => cell.cell_type === "code").map((cell) => cell.source.join("")).sort();
    expect(sources).toEqual(["a = 1\n", "b = 2\n"]);
  });

  it("does not duplicate or drop outputs when the same source key is saved concurrently", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await Promise.all([
      service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: { ok: true, stdout: "", result: "one", error: null } }),
      service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n", result: { ok: true, stdout: "", result: "two", error: null } }),
    ]);

    const notebook = await readNotebook(cwd);
    // One winner, one code cell, exactly one execute_result — never both
    // appended nor both dropped.
    expect(notebook.cells).toHaveLength(2);
    const code = notebook.cells[1]!;
    expect(code.outputs).toHaveLength(1);
    const outputs = code.outputs as Array<Record<string, unknown>>;
    expect(outputs[0]).toMatchObject({ output_type: "execute_result" });
    const textParts = (outputs[0]!.data as Record<string, unknown>)["text/plain"] as string[] | undefined;
    expect(textParts).toBeDefined();
    expect(["one\n", "two\n"]).toContain(textParts!.join(""));
  });

  it("refuses to overwrite an existing file that is not a valid notebook", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    await mkdir(join(cwd, "notebooks"), { recursive: true });
    await writeFile(join(cwd, "notebooks", `chat-${SESSION}-analysis.ipynb`), "not json at all", "utf8");
    const service = new ChatNotebookService();

    const outcome = await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x = 1\n" });

    expect(outcome).toMatchObject({ ok: false, code: "conflict" });
    expect(await readFile(join(cwd, "notebooks", `chat-${SESSION}-analysis.ipynb`), "utf8")).toBe("not json at all");
  });

  it("rejects oversized code and result payloads", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    const bigCode = await service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "x".repeat(MAX_CODE_BYTES + 1) });
    expect(bigCode).toMatchObject({ ok: false, code: "code_too_large" });

    const bigResult = await service.save(cwd, {
      session_id: SESSION,
      message_id: ASSISTANT,
      code: "x = 1\n",
      result: { ok: true, stdout: "y".repeat(MAX_RESULT_BYTES + 1), result: null, error: null },
    });
    expect(bigResult).toMatchObject({ ok: false, code: "result_too_large" });
  });

  it("rejects unknown sessions, unknown messages and non-assistant messages", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await expect(service.save(cwd, { session_id: "no-such-session", message_id: ASSISTANT, code: "x = 1\n" })).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(service.save(cwd, { session_id: SESSION, message_id: "no-such-message", code: "x = 1\n" })).resolves.toMatchObject({ ok: false, code: "not_found" });
    await expect(service.save(cwd, { session_id: SESSION, message_id: USER, code: "x = 1\n" })).resolves.toMatchObject({ ok: false, code: "not_found" });
  });

  it("rejects missing fields and non-python languages", async () => {
    const cwd = await makeWorkspace();
    await writeSession(cwd);
    const service = new ChatNotebookService();

    await expect(service.save(cwd, { session_id: "", message_id: ASSISTANT, code: "x = 1\n" })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(service.save(cwd, { session_id: SESSION, message_id: "", code: "x = 1\n" })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, code: "" })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(service.save(cwd, { session_id: SESSION, message_id: ASSISTANT, language: "r", code: "x = 1\n" })).resolves.toMatchObject({ ok: false, code: "invalid_request" });
  });
});
