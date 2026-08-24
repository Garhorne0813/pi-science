import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(edited.json()).toMatchObject({ ok: true, changed_cell_ids: [cellId], stale_cell_ids: [cellId] });
    const stored = JSON.parse(await readFile(join(cwd, path), "utf8")) as { cells: Array<{ id: string; source: string; execution_count: number | null; outputs: unknown[] }> };
    expect(stored.cells[0]).toMatchObject({ id: cellId, source: "value = 2\n", execution_count: null, outputs: [] });

    const conflict = await app.inject({
      method: "POST",
      url: `/api/notebooks/edit?cwd=${encodeURIComponent(cwd)}`,
      payload: { path, expected_sha256: readBody.sha256, operations: [{ cell_id: cellId, action: "replace_source", source: "value = 3\n" }] },
    });
    expect(conflict.statusCode).toBe(409);
    await app.close();
  });
});
