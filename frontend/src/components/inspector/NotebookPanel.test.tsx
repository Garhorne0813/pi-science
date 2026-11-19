import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import hljs from "highlight.js/lib/common";
import type { ExecutionRecord } from "@pi-science/contracts";
import { i18nReady } from "../../i18n";
import { NotebookPanel } from "./NotebookPanel";

await i18nReady;

const fixture = vi.hoisted(() => ({ runs: [] as ExecutionRecord[] }));

vi.mock("../../lib/runs", () => ({
  sessionRunsQuery: (_cwd: string, _sessionId: string, liveConnected: boolean) => ({
    queryKey: ["notebook-panel-test", "runs", liveConnected],
    queryFn: async () => fixture.runs,
  }),
}));

vi.mock("../../lib/runs/execution-events", () => ({
  subscribeExecutionInvalidation: () => () => undefined,
}));

vi.mock("../../lib/notebook", () => ({
  notebookRuntime: {
    capabilities: async () => ({ python: true, r: true }),
  },
}));

vi.mock("../../lib/client/api", () => ({
  apiRequest: async () => ({ display_name: "Visual Demo", revision_id: "rev-fixture" }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fixture.runs = [];
});

function kernelRun(surface: "python" | "r", code: string): ExecutionRecord {
  return {
    schema_version: 1,
    execution_id: `exec-${surface}`,
    kind: "kernel_cell",
    surface,
    status: "succeeded",
    workspace_id: "/workspace",
    created_at: "2026-08-15T09:00:00.000Z",
    started_at: "2026-08-15T09:00:00.000Z",
    ended_at: "2026-08-15T09:00:01.000Z",
    producer: "node-kernel-gateway",
    correlation: { request_id: "request-1", session_id: "session-1" },
    request: { notebook_id: "session-session-1", code, language: surface, source: "session_notebook" },
    runtime: { cwd: "/workspace" },
    result: { stdout_preview: "ok\n", output_preview: "" },
    files: { read: [], written: [] },
    artifacts: [],
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotebookPanel onClose={() => undefined} cwd="/workspace" sessionId="session-1" />
    </QueryClientProvider>,
  );
}

async function codeText(container: HTMLElement, expected: string) {
  await waitFor(() => expect(container.querySelector("code")?.textContent).toBe(expected));
}

describe("NotebookPanel historical kernel cells", () => {
  const pythonCode = "def fold_change(values):\n    return [value / values[0] for value in values]\n";
  const rCode = "fold_change <- function(x) x / x[1]\nprint(fold_change(c(1, 2, 4)))\n";

  beforeEach(() => {
    fixture.runs = [];
  });

  it("highlights a Python kernel_cell with the Python grammar", async () => {
    fixture.runs = [kernelRun("python", pythonCode)];
    const highlight = vi.spyOn(hljs, "highlight");
    const auto = vi.spyOn(hljs, "highlightAuto");
    const { container } = renderPanel();

    await codeText(container, pythonCode);
    expect(highlight).toHaveBeenCalledWith(pythonCode, { language: "python" });
    expect(auto).not.toHaveBeenCalled();
  });

  it("highlights an R kernel_cell with the R grammar", async () => {
    fixture.runs = [kernelRun("r", rCode)];
    const highlight = vi.spyOn(hljs, "highlight");
    const auto = vi.spyOn(hljs, "highlightAuto");
    const { container } = renderPanel();

    await codeText(container, rCode);
    expect(highlight).toHaveBeenCalledWith(rCode, { language: "r" });
    expect(auto).not.toHaveBeenCalled();
  });
});
