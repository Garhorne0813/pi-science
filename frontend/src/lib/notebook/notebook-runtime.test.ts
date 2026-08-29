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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, stdout: "42\n", result: null, error: null, execution_id: "exec_cell" }), { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notebookRuntime.execute("nb 1", "/tmp/lab", "python", "print(42)")).resolves.toMatchObject({ ok: true, stdout: "42\n", execution_id: "exec_cell" });
    expect(fetchMock).toHaveBeenCalledWith("/api/kernels/execute?cwd=%2Ftmp%2Flab", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ language: "python", code: "print(42)", notebook_id: "nb 1" });
  });

  it("normalizes kernel errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "kernel stopped" }), { status: 409, headers: JSON_HEADERS })));
    await expect(notebookRuntime.execute("nb", ".", "python", "1")).rejects.toThrow("kernel stopped");
  });

  it("associates conversation code execution with its session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, stdout: "", result: "2", error: null }), { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);

    await notebookRuntime.execute("chat-session-1", "/tmp/lab", "python", "1 + 1", "session-1");

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      language: "python",
      code: "1 + 1",
      notebook_id: "chat-session-1",
      session_id: "session-1",
    });
  });

  it("interrupts only the selected notebook kernel and language", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS }));
    vi.stubGlobal("fetch", fetchMock);

    await notebookRuntime.interrupt("session-1", "/tmp/lab", "python");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kernels/session-1/interrupt?cwd=%2Ftmp%2Flab&language=python",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("streams cell output before returning the final MIME result", async () => {
    const body = [
      JSON.stringify({ type: "started", execution_id: "exec-stream" }),
      JSON.stringify({ type: "stream", stream: "stdout", text: "step 1\n" }),
      JSON.stringify({ type: "stream", stream: "stderr", text: "warning\n" }),
      JSON.stringify({ type: "result", ok: true, stdout: "step 1\nwarning\n", result: "2", error: null, mime: { "application/json": "2" }, outputs: [{ output_type: "display_data", data: { "text/plain": "shown" } }], execution_id: "exec-stream" }),
    ].join("\n") + "\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } })));
    const onEvent = vi.fn();

    const result = await notebookRuntime.executeStreaming("session-1", "/tmp/lab", "python", "print('step 1')\n2", "session-1", { source: "session_notebook" }, onEvent);

    expect(onEvent).toHaveBeenNthCalledWith(1, { type: "started", execution_id: "exec-stream" });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: "stream", stream: "stdout", text: "step 1\n" });
    expect(onEvent).toHaveBeenNthCalledWith(3, { type: "stream", stream: "stderr", text: "warning\n" });
    expect(result).toMatchObject({ ok: true, result: "2", execution_id: "exec-stream", mime: { "application/json": "2" }, outputs: [{ output_type: "display_data", data: { "text/plain": "shown" } }] });
  });
});
