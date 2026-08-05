import { afterEach, describe, expect, it, vi } from "vitest";
import { notebookRuntime } from "./notebook-runtime";
import { queryClient } from "../client/query-client";

const JSON_HEADERS = { "Content-Type": "application/json" };

const SAVE_RESPONSE = {
  ok: true,
  path: "notebooks/会话-1.ipynb",
  created_notebook: true,
  appended: false,
  updated: false,
  cell_index: 0,
  cell_count: 1,
  revision: 4,
};

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("notebook runtime", () => {
  it("executes a cell through one notebook-scoped interface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, stdout: "42\n", result: null, error: null }), { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notebookRuntime.execute("nb 1", "/tmp/lab", "python", "print(42)")).resolves.toMatchObject({ ok: true, stdout: "42\n" });
    expect(fetchMock).toHaveBeenCalledWith("/api/kernels/execute?cwd=%2Ftmp%2Flab", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ language: "python", code: "print(42)", notebook_id: "nb 1" });
  });

  it("normalizes kernel errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "kernel stopped" }), { status: 409, headers: JSON_HEADERS })));
    await expect(notebookRuntime.execute("nb", ".", "python", "1")).rejects.toThrow("kernel stopped");
  });

  it("saves a chat cell with URL-encoded cwd, full body, and cache invalidation", async () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SAVE_RESPONSE), { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);

    const request = {
      session_id: "sess-1",
      message_id: "msg-1",
      source_line: 12,
      language: "python" as const,
      code: 'print("中文数据")',
      result: { ok: true, stdout: "42\n", result: null, error: null },
      model_at_save: "custom-gpt/gpt-5.6-luna",
      message_timestamp: "2026-08-05T00:00:00Z",
    };

    await expect(notebookRuntime.saveChatCell("/tmp/工作区", request)).resolves.toMatchObject(SAVE_RESPONSE);
    expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/notebooks/save?cwd=%2Ftmp%2F%E5%B7%A5%E4%BD%9C%E5%8C%BA", expect.objectContaining({ method: "POST" }));
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent).toEqual(request);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["notebooks", "/tmp/工作区"] });
  });

  it("surfaces notebook save errors with the server message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "cell too large" }), { status: 413, headers: JSON_HEADERS })));
    await expect(notebookRuntime.saveChatCell(".", { session_id: "s", message_id: "m", language: "python", code: "x" }))
      .rejects.toThrow("cell too large");
  });
});
