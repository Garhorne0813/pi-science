import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionRecord } from "../../types/thread";
import { runsQuery, sessionRunsQuery } from "./runs";

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
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes active executions quickly and idle ledgers quietly", () => {
    const interval = runsQuery("/workspace").refetchInterval;
    expect(interval({ state: { data: [record("running")] } })).toBe(5_000);
    expect(interval({ state: { data: [record("succeeded")] } })).toBe(30_000);
    expect(interval({ state: {} })).toBe(30_000);
  });

  it("requests only the selected session for the inspector", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ executions: [record("succeeded")] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionRunsQuery("/workspace/demo", "session-1").queryFn();

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("session_id=session-1"), expect.anything());
  });
});
