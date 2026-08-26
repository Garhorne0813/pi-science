import Fastify from "fastify";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotebookService } from "../../runtime/notebooks/notebook-service.js";
import { registerNotebookRoutes } from "./notebook-routes.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("notebook document routes", () => {
  it("reads stable ids, edits atomically, and rejects stale revisions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-notebook-routes-"));
    cleanup.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    const path = "analysis/demo.ipynb";
    await mkdir(join(cwd, "analysis"));
    await writeFile(join(cwd, path), `${JSON.stringify({
      metadata: { kernelspec: { language: "python" } },
      cells: [{ cell_type: "code", source: "value = 1\n", execution_count: 1, outputs: [{ output_type: "execute_result", data: { "text/plain": ["1"] } }] }],
    }, null, 2)}\n`, "utf8");
    await chmod(join(cwd, path), 0o600);

    const app = Fastify();
    registerNotebookRoutes(app, new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) }));
    const read = await app.inject({ method: "GET", url: `/api/notebooks/document?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}` });
    expect(read.statusCode).toBe(200);
    const readBody = read.json() as { sha256: string; document: { cells: Array<{ id: string }> } };
    const cellId = readBody.document.cells[0]!.id;

    const edited = await app.inject({
      method: "POST",
      url: `/api/notebooks/edit?cwd=${encodeURIComponent(cwd)}`,
      payload: { path, expected_sha256: readBody.sha256, operations: [{ cell_id: cellId, action: "replace_source", source: "value = 2\n" }] },
    });
    expect(edited.statusCode).toBe(200);
    const editedBody = edited.json() as { sha256: string };
    expect(editedBody).toMatchObject({ ok: true, changed_cell_ids: [cellId], stale_cell_ids: [cellId] });
    const stored = JSON.parse(await readFile(join(cwd, path), "utf8")) as { cells: Array<{ id: string; source: string; execution_count: number | null; outputs: unknown[] }> };
    expect(stored.cells[0]).toMatchObject({ id: cellId, source: "value = 2\n", execution_count: null, outputs: [] });
    expect((await stat(join(cwd, path))).mode & 0o7777).toBe(0o600);

    const output = await app.inject({
      method: "POST",
      url: `/api/notebooks/output?cwd=${encodeURIComponent(cwd)}`,
      payload: {
        path,
        expected_sha256: editedBody.sha256,
        cell_id: cellId,
        execution_count: 2,
        execution_id: "exec-notebook-cell",
        outputs: [
          { output_type: "stream", name: "stdout", text: "value\n" },
          { output_type: "execute_result", execution_count: 2, data: { "text/plain": "2" } },
          { output_type: "error", ename: "ExampleError", evalue: "ignored preview" },
        ],
      },
    });
    expect(output.statusCode).toBe(200);
    expect(output.json()).toMatchObject({ ok: true, cell_id: cellId, execution_count: 2, output_count: 3 });
    const afterOutput = JSON.parse(await readFile(join(cwd, path), "utf8")) as { cells: Array<{ execution_count: number | null; outputs: unknown[] }> };
    expect(afterOutput.cells[0]).toMatchObject({ execution_count: 2, outputs: expect.arrayContaining([{ output_type: "stream", name: "stdout", text: "value\n" }]) });
    expect((await stat(join(cwd, path))).mode & 0o7777).toBe(0o600);
    const provenance = (await readFile(join(cwd, ".pi-science", "provenance.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(provenance.at(-1)).toMatchObject({ tool: "notebook_run", executionId: "exec-notebook-cell" });

    const conflict = await app.inject({
      method: "POST",
      url: `/api/notebooks/edit?cwd=${encodeURIComponent(cwd)}`,
      payload: { path, expected_sha256: readBody.sha256, operations: [{ cell_id: cellId, action: "replace_source", source: "value = 3\n" }] },
    });
    expect(conflict.statusCode).toBe(409);
    await app.close();
  });
});
