import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../../i18n";
import { queryClient } from "../../lib/client/query-client";
import type { ExecutionRecord } from "../../types/thread";
import { RunsPage } from "./RunsPage";

vi.mock("../../lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspace")>();
  return { ...actual, useRequiredWorkspaceCwd: () => "/workspace" };
});

vi.mock("../../components/feedback/feedback-context", () => ({
  useFeedback: () => ({ toast: vi.fn() }),
}));

vi.mock("../../components/layout/WorkspacePage", () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WorkspacePageHeader: ({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) => <header>{title}{description}{actions}</header>,
  WorkspacePageRefreshButton: ({ label, onClick }: { label: string; onClick: () => void }) => <button onClick={onClick}>{label}</button>,
}));

const kernelExecution: ExecutionRecord = {
  schema_version: 1,
  execution_id: "exec_kernel",
  kind: "kernel_cell",
  surface: "python",
  status: "succeeded",
  workspace_id: "/workspace",
  created_at: "2026-08-15T01:00:00.000Z",
  started_at: "2026-08-15T01:00:00.000Z",
  ended_at: "2026-08-15T01:00:02.500Z",
  producer: "node-kernel-gateway",
  correlation: { request_id: "request-1" },
  request: { notebook_id: "analysis.ipynb", code: "print('ok')\n2 + 2", language: "python" },
  runtime: { cwd: "/workspace", gateway_timeout_ms: 125_000 },
  result: { stdout_preview: "ok\n", output_preview: "4" },
  files: { read: [{ path: "data/input.csv", detection: "explicit" }], written: [{ path: "outputs/result.csv", detection: "snapshot" }] },
  artifacts: [{ artifact_id: "artifact-result", version: 2, relation: "output" }],
};

const jobExecution: ExecutionRecord = {
  schema_version: 1,
  execution_id: "exec_job",
  kind: "job",
  surface: "local",
  status: "failed",
  workspace_id: "/workspace",
  created_at: "2026-08-15T02:00:00.000Z",
  started_at: "2026-08-15T02:00:00.000Z",
  ended_at: "2026-08-15T02:00:01.000Z",
  producer: "node-job-coordinator",
  correlation: { job_id: "job_1" },
  request: { command: ["node", "train.js"] },
  runtime: { platform: "darwin" },
  result: { exit_code: 1, stderr_preview: "training failed" },
  files: { read: [], written: [] },
  artifacts: [],
};

const toolExecution: ExecutionRecord = {
  schema_version: 1,
  execution_id: "exec_tool",
  kind: "tool",
  surface: "pi",
  status: "running",
  workspace_id: "/workspace",
  created_at: "2026-08-15T03:00:00.000Z",
  started_at: "2026-08-15T03:00:00.000Z",
  producer: "node-pi-event-observer",
  correlation: { session_id: "session-1", tool_call_id: "call-1" },
  request: { tool: "write", input: { path: "report.md" } },
  runtime: { model: "test-model" },
  result: {},
  files: { read: [], written: [{ path: "report.md", detection: "explicit" }] },
  artifacts: [],
};

const executions = [toolExecution, jobExecution, kernelExecution];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/executions?") || url.includes("/api/executions?")) return jsonResponse({ executions });
  if (url.includes("/api/executions/exec_kernel/logs")) return jsonResponse({ stdout: "kernel stdout", stderr: "" });
  if (url.includes("/api/executions/exec_job/logs")) return jsonResponse({ stdout: "", stderr: "job stderr" });
  if (url.includes("/api/executions/exec_tool/logs")) return jsonResponse({ stdout: "tool output", stderr: "" });
  return jsonResponse({ error: `unhandled ${url}` }, 404);
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.search}</output>;
}

function renderPage(initial = "/workspace/project/runs") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/workspace/:cwd/runs" element={<><RunsPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  queryClient.clear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RunsPage execution ledger", () => {
  it("selects the newest execution and stores the selection in the URL", async () => {
    renderPage();

    await screen.findAllByText("write");
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_tool"));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "false");
    expect(screen.getByText("node-pi-event-observer")).toBeInTheDocument();
    expect(screen.getAllByText("Running", { selector: "dd" }).length).toBeGreaterThan(0);
  });

  it("honors a deep-linked selection and updates it when another row is selected", async () => {
    renderPage("/workspace/project/runs?execution=exec_job");

    await screen.findByText("node-job-coordinator");
    expect(screen.getByText("Failed", { selector: "dd" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /analysis\.ipynb/ }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_kernel"));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "true");
    expect(screen.getByText("node-kernel-gateway")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to executions" }));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "false");
  });

  it("filters by search text, kind, and status", async () => {
    renderPage();
    await screen.findAllByText("write");

    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "result.csv" } });
    expect(await screen.findByRole("button", { name: /analysis\.ipynb/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /node train\.js/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by execution type"), { target: { value: "job" } });
    expect(await screen.findByRole("button", { name: /node train\.js/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "succeeded" } });
    expect(await screen.findByText("No matching executions")).toBeInTheDocument();
  });

  it("shows input, files, artifacts, timing, and lazily loaded output", async () => {
    renderPage("/workspace/project/runs?execution=exec_kernel");
    await screen.findByText("node-kernel-gateway");

    fireEvent.click(screen.getByRole("tab", { name: "Input" }));
    expect(screen.getByText(/print\('ok'\)/, { selector: "pre" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("data/input.csv")).toBeInTheDocument();
    expect(screen.getByText("outputs/result.csv")).toBeInTheDocument();
    expect(screen.getByText("artifact-result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Timing" }));
    expect(screen.getAllByText("2.5 s").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    expect(await screen.findByText("kernel stdout")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/executions/exec_kernel/logs"), expect.anything());
  });
});
