import { afterEach, describe, expect, it, vi } from "vitest";
import registerNotebook from "./pi-science-notebook.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pi-Science notebook extension", () => {
  it("reads, edits, and runs through the Node control plane", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/notebooks/document")) {
        return new Response(JSON.stringify({
          path: "analysis/demo.ipynb",
          sha256: "a".repeat(64),
          document: {
            metadata: { kernelspec: { language: "python" } },
            cells: [
              { id: "c1", cell_type: "code", source: "x = 1\n", execution_count: null, outputs: [] },
              { id: "c2", cell_type: "code", source: "print(x)\n", execution_count: null, outputs: [] },
            ],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/notebooks/edit")) {
        return new Response(JSON.stringify({ ok: true, path: "analysis/demo.ipynb", sha256: "b".repeat(64), changed_cell_ids: ["c1"], stale_cell_ids: ["c1"] }), { status: 200 });
      }
      if (url.includes("/api/kernels/execute")) {
        return new Response(JSON.stringify({ ok: true, execution_id: "exec-1", status: "succeeded" }), { status: 200 });
      }
      if (url.includes("/api/executions/exec-1")) {
        return new Response(JSON.stringify({ execution_id: "exec-1", status: "succeeded", result: { stdout_preview: "1\n" } }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const tools = new Map<string, any>();
    registerNotebook({ registerTool: (tool: any) => tools.set(tool.name, tool) });
    const ctx = { cwd: "/workspace", sessionId: "session-1" };

    const read = await tools.get("notebook_read").execute("read-1", { path: "analysis/demo.ipynb", include_outputs: false }, undefined, undefined, ctx);
    expect(read.details).toMatchObject({ path: "analysis/demo.ipynb", sha256: "a".repeat(64) });
    expect(read.details.cells).toHaveLength(2);

    const edit = await tools.get("notebook_edit").execute("edit-1", {
      path: "analysis/demo.ipynb",
      expected_sha256: "a".repeat(64),
      operations: [{ cell_id: "c1", action: "replace_source", source: "x = 2\n" }],
    }, undefined, undefined, ctx);
    expect(edit.content[0].text).toContain("New revision");

    const run = await tools.get("notebook_run").execute("run-1", { path: "analysis/demo.ipynb", cell_ids: ["c1", "c2"] }, undefined, undefined, ctx);
    expect(run.content[0].text).toContain("Ran 2/2 cell(s)");
    expect(calls.filter((call) => call.url.includes("/api/kernels/execute")).map((call) => JSON.parse(String(call.init.body)).cell_id)).toEqual(["c1", "c2"]);
    expect(JSON.parse(String(calls.find((call) => call.url.includes("/api/notebooks/edit"))?.init.body))).toMatchObject({ session_id: "session-1", expected_sha256: "a".repeat(64) });
  });
});
