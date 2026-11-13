import type { ExecutionRecord } from "@pi-science/contracts";
import { describe, expect, it } from "vitest";
import { sessionKernelHistory } from "./NotebookPanel";

function cell(execution_id: string, source: string | undefined, kind = "kernel_cell"): ExecutionRecord {
  return {
    schema_version: 1,
    execution_id,
    kind,
    surface: "python",
    status: "succeeded",
    workspace_id: "w",
    created_at: "2026-11-13T00:00:00.000Z",
    producer: "test",
    correlation: {},
    request: { ...(source ? { source } : {}), notebook_id: "session", code: "x = 1" },
    runtime: {},
    result: {},
    files: { read: [], written: [] },
    artifacts: [],
  } as unknown as ExecutionRecord;
}

describe("sessionKernelHistory", () => {
  it("hides chat runs from the session kernel history", () => {
    const history = sessionKernelHistory([
      cell("session", "session_notebook"),
      cell("chat", "chat"),
      cell("agent", "agent"),
      cell("legacy", undefined),
      cell("tool", undefined, "tool"),
    ]);
    expect(history.map((run) => run.execution_id)).toEqual(["session", "agent", "legacy"]);
  });
});
