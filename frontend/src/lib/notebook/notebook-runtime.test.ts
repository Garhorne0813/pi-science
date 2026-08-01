import { afterEach, describe, expect, it, vi } from "vitest";
import { notebookRuntime } from "./notebook-runtime";
import { queryClient } from "../client/query-client";

const JSON_HEADERS = { "Content-Type": "application/json" };

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
});
