import { describe, expect, it } from "vitest";
import type { ExecutionRecord } from "../../types/thread";
import { runsQuery } from "./runs";

function record(status: ExecutionRecord["status"]): ExecutionRecord {
  return {
    schema_version: 1,
    execution_id: `exec_${status}`,
    kind: "tool",
    surface: "pi",
    status,
    workspace_id: "/workspace",
    created_at: "2026-08-15T01:00:00.000Z",
    producer: "test",
    correlation: {},
    request: {},
    runtime: {},
    result: {},
    files: { read: [], written: [] },
    artifacts: [],
  };
}

describe("runsQuery", () => {
  it("refreshes active executions quickly and idle ledgers quietly", () => {
    const interval = runsQuery("/workspace").refetchInterval;
    expect(interval({ state: { data: [record("running")] } })).toBe(1_000);
    expect(interval({ state: { data: [record("succeeded")] } })).toBe(5_000);
    expect(interval({ state: {} })).toBe(5_000);
  });
});
