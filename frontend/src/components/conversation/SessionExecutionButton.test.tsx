import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { queryClient } from "../../lib/client/query-client";
import { SessionExecutionButton } from "./SessionExecutionButton";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function execution(index: number) {
  return {
    schema_version: 1,
    execution_id: `exec-${index}`,
    kind: "tool",
    surface: "pi",
    status: "succeeded",
    workspace_id: "/workspace",
    created_at: "2026-01-01T00:00:00.000Z",
    producer: "test",
    correlation: { session_id: "session-1" },
    request: { tool: "bash", input: {} },
    runtime: {},
    result: {},
    files: { read: [], written: [] },
    artifacts: [],
    usage: {},
  };
}

describe("SessionExecutionButton", () => {
  it("shows the session execution count and exposes its selected state", async () => {
    const onToggle = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      executions: [{
        schema_version: 1,
        execution_id: "exec_1",
        kind: "tool",
        surface: "pi",
        status: "succeeded",
        workspace_id: "/workspace",
        session_id: "session-1",
        created_at: "2026-08-15T01:00:00.000Z",
        producer: "test",
        correlation: {},
        request: { tool: "bash" },
        runtime: {},
        result: {},
        files: { read: [], written: [] },
        artifacts: [],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(
      <QueryClientProvider client={queryClient}>
        <SessionExecutionButton cwd="/workspace" sessionId="session-1" active onToggle={onToggle} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "1 execution in this session" });
    expect(button).toHaveTextContent("1");
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("reports the failed count when nothing is running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      executions: [
        { ...execution(1), execution_id: "exec-failed", status: "failed" },
        { ...execution(2), execution_id: "exec-ok", status: "succeeded" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(
      <QueryClientProvider client={queryClient}>
        <SessionExecutionButton cwd="/workspace" sessionId="session-1" active={false} onToggle={() => undefined} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "1 failed execution in this session" });
    const dot = button.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("bg-error");
  });

  it("reports running and failed counts together", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      executions: [
        { ...execution(1), execution_id: "exec-running", status: "running" },
        { ...execution(2), execution_id: "exec-failed", status: "failed" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(
      <QueryClientProvider client={queryClient}>
        <SessionExecutionButton cwd="/workspace" sessionId="session-1" active={false} onToggle={() => undefined} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: "1 running, 1 failed in this session" });
  });

  it("shows all executions returned for the current session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      executions: Array.from({ length: 70 }, (_, index) => execution(index)),
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(
      <QueryClientProvider client={queryClient}>
        <SessionExecutionButton cwd="/workspace" sessionId="session-1" active={false} onToggle={() => undefined} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("button")).toHaveTextContent("70"));
  });
});
