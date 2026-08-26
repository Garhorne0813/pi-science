// Unit tests for the scheduled-tasks client: cwd encoding (including spaces),
// 202 manual-run handling, 409 conflict propagation and cursor pagination.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../client/api";
import {
  approveScheduledTask,
  deleteScheduledTask,
  isConflict,
  listScheduledTasks,
  listScheduledAttempts,
  patchScheduledTask,
  manualRunToRow,
  previewScheduledSchedule,
  runScheduledTaskNow,
  scheduledErrorCode,
} from "./scheduled-tasks";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scheduled tasks client", () => {
  it("URL-encodes the cwd query parameter, including spaces", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], next_cursor: null }));

    await listScheduledTasks("/Users/dev/my dir");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith("/api/scheduled-tasks?")).toBe(true);
    // URLSearchParams encodes a space as "+" and never leaks a raw space.
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("cwd")).toBe("/Users/dev/my dir");
    expect(url).toContain("my+dir");
    expect(url).not.toContain(" my dir");
  });

  it("treats a 202 manual run as success and returns the pending run view", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run: { run_id: "run_1", task_id: "stask_1", status: "pending", trigger_source: "manual", latest_attempt: null } }, 202));

    const result = await runScheduledTaskNow("stask_1", "/ws");

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/stask_1/run?"), expect.objectContaining({ method: "POST" }));
    expect(result.run.status).toBe("pending");
    expect(manualRunToRow(result.run)).toMatchObject({ run_id: "run_1", status: "pending", trigger_source: "manual", attempt_count: 0 });
  });

  it("propagates 409 conflicts with the server error code for PATCH and approve", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/approve")) return jsonResponse({ code: "SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED", error: "scope changed", request_id: "r2", details: {} }, 409);
      return jsonResponse({ code: "SCHEDULED_TASK_REVISION_CONFLICT", error: "revision changed", request_id: "r1", details: { expected_revision: 1, actual_revision: 4 } }, 409);
    });

    const patchError = await patchScheduledTask("stask_1", "/ws", 1, { name: "Renamed" }).catch((error: unknown) => error);
    const approveError = await approveScheduledTask("stask_1", "/ws", { expected_revision: 1, approval_scope_hash: "sha256_x", categories: ["dna-sequence"] }).catch((error: unknown) => error);

    expect(patchError).toBeInstanceOf(ApiError);
    expect((patchError as ApiError).status).toBe(409);
    expect(scheduledErrorCode(patchError)).toBe("SCHEDULED_TASK_REVISION_CONFLICT");
    expect(isConflict(approveError)).toBe(true);
    expect(scheduledErrorCode(approveError)).toBe("SCHEDULED_TASK_APPROVAL_SCOPE_CHANGED");
  });

  it("passes limit and opaque cursors through to list endpoints", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], next_cursor: null }));

    await listScheduledTasks("/ws", { limit: 25, cursor: "op/aque+cursor==" });
    await listScheduledAttempts("stask_1", "run_1", "/ws", { cursor: "next-page" });

    const [tasksUrl, attemptsUrl] = fetchMock.mock.calls.map((call) => String(call[0]));
    const taskParams = new URL(tasksUrl, "http://localhost").searchParams;
    const attemptParams = new URL(attemptsUrl, "http://localhost").searchParams;
    expect(taskParams.get("limit")).toBe("25");
    expect(taskParams.get("cursor")).toBe("op/aque+cursor==");
    expect(attemptParams.get("cursor")).toBe("next-page");
    expect(attemptsUrl).toContain("/api/scheduled-tasks/stask_1/runs/run_1/attempts?");
  });

  it("sends expected_revision on the DELETE query string", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deleted: true }));

    await deleteScheduledTask("stask_1", "/ws", 3);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url, "http://localhost").searchParams.get("expected_revision")).toBe("3");
    expect(init.method).toBe("DELETE");
  });

  it("posts schedule previews to the server-authoritative endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [{ local: "2026-08-26 09:00", utc: "2026-08-26T01:00:00.000Z" }] }));

    const result = await previewScheduledSchedule("/ws", { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("/api/scheduled-tasks/preview?")).toBe(true);
    expect(JSON.parse(String(init.body))).toMatchObject({ count: 3, schedule: { timezone: "Asia/Shanghai" } });
    expect(result.items[0]).toEqual({ local: "2026-08-26 09:00", utc: "2026-08-26T01:00:00.000Z" });
  });
});
