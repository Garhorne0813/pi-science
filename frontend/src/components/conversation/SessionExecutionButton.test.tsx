import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { queryClient } from "../../lib/client/query-client";
import { useUiStore } from "../../lib/ui";
import { SessionExecutionButton } from "./SessionExecutionButton";

vi.mock("../../lib/runs/execution-events", () => ({
  subscribeExecutionInvalidation: () => vi.fn(),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  queryClient.clear();
  useUiStore.setState({
    inspectorOpen: false,
    inspectorData: null,
    inspectorTabs: [],
    activeInspectorTabId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SessionExecutionButton", () => {
  it("shows the session execution count and opens its inspector", async () => {
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
        <SessionExecutionButton cwd="/workspace" sessionId="session-1" />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "1 execution in this session" });
    expect(button).toHaveTextContent("1");
    fireEvent.click(button);

    await waitFor(() => expect(useUiStore.getState().inspectorData).toEqual({
      variant: "executions",
      cwd: "/workspace",
      sessionId: "session-1",
    }));
  });
});
