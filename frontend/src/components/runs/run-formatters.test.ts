import type { ExecutionRecord } from "@pi-science/contracts";
import { describe, expect, it } from "vitest";
import { executionLabel } from "./run-formatters";

function run(patch: Partial<ExecutionRecord> & { request?: Record<string, unknown>; surface?: string }): ExecutionRecord {
  return {
    schema_version: 1,
    execution_id: "e1",
    kind: "kernel_cell",
    surface: "python",
    status: "succeeded",
    workspace_id: "w",
    created_at: "2026-11-13T00:00:00.000Z",
    producer: "test",
    correlation: {},
    request: {},
    runtime: {},
    result: {},
    files: { read: [], written: [] },
    artifacts: [],
    ...patch,
  } as unknown as ExecutionRecord;
}

describe("executionLabel for kernel cells", () => {
  it("shows the code line of a chat run instead of its synthetic chat notebook id", () => {
    const label = executionLabel(run({ request: { source: "chat", notebook_id: "chat-s1", code: "print(1)\nprint(2)" } }));
    expect(label).toBe("print(1)");
    expect(label).not.toContain("chat-s1");
  });

  it("keeps the notebook id prefix for session-kernel runs", () => {
    expect(executionLabel(run({ request: { source: "session_notebook", notebook_id: "nb.ipynb", code: "x = 1" } }))).toBe("nb.ipynb · x = 1");
  });

  it("falls back to the surface for a chat run without code", () => {
    expect(executionLabel(run({ request: { source: "chat" } }))).toBe("python");
  });
});
