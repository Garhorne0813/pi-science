import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams, useNavigate } from "react-router-dom";
import i18n from "../../i18n";
import { queryClient } from "../../lib/client/query-client";
import type { ExecutionRecord } from "@pi-science/contracts";
import { RunsPage } from "./RunsPage";

const { toastMock, openInspectorMock, setDraftMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  openInspectorMock: vi.fn(),
  setDraftMock: vi.fn(),
}));

vi.mock("../../lib/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ui")>();
  return { ...actual, useUiStore: (selector: (state: { openInspector: typeof openInspectorMock }) => unknown) => selector({ openInspector: openInspectorMock }) };
});

vi.mock("../../lib/agent-runtime", () => ({
  useRuntimeStore: (selector: (state: { setDraft: typeof setDraftMock }) => unknown) => selector({ setDraft: setDraftMock }),
}));

vi.mock("../../lib/runs/execution-events", () => ({
  subscribeExecutionInvalidation: () => () => undefined,
}));

vi.mock("../../lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspace")>();
  return { ...actual, useRequiredWorkspaceCwd: () => "/workspace" };
});

vi.mock("../../components/feedback/feedback-context", () => ({
  useFeedback: () => ({ toast: toastMock }),
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
  producer: "agent-event-observer",
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

const fetchExecutions = async (input: RequestInfo | URL, records: ExecutionRecord[] = executions) => {
  const url = String(input);
  if (url.includes("/api/executions?")) {
    const params = new URL(url, "http://localhost").searchParams;
    const scoped = records.filter((run) => !params.get("session_id") || run.correlation.session_id === params.get("session_id"));
    const filtered = scoped.filter((run) => (!params.get("kind") || run.kind === params.get("kind")) &&
      (!params.get("status") || run.status === params.get("status")) &&
      (!params.get("search") || JSON.stringify(run).toLowerCase().includes(params.get("search")!.toLowerCase())));
    const offset = Number(params.get("offset") || 0);
    const targetIndex = filtered.findIndex((run) => run.execution_id === params.get("target_id"));
    return jsonResponse({ executions: filtered.slice(offset, offset + 50), total: scoped.length, filtered_total: filtered.length, offset, limit: 50,
      status_counts: { running: scoped.filter((run) => run.status === "running").length, succeeded: scoped.filter((run) => run.status === "succeeded").length, failed: scoped.filter((run) => run.status === "failed").length },
      target_in_scope: scoped.some((run) => run.execution_id === params.get("target_id")), target_matches: targetIndex >= 0, target_offset: targetIndex >= 0 ? Math.floor(targetIndex / 50) * 50 : null });
  }
  if (url.includes("/api/executions/exec_kernel/logs")) return jsonResponse({ stdout: "kernel stdout", stderr: "", source: "preview", complete: false });
  if (url.includes("/api/executions/exec_job/logs")) return jsonResponse({ stdout: "", stderr: "job stderr", source: "job", complete: true });
  if (url.includes("/api/executions/exec_tool/logs")) return jsonResponse({ stdout: "tool output", stderr: "", source: "preview", complete: false });
  if (url.includes("/api/artifacts/artifact-result")) return jsonResponse({ path: "outputs/result.csv" });
  const id = new URL(url, "http://localhost").pathname.match(/^\/api\/executions\/([^/]+)$/)?.[1];
  const record = records.find((run) => run.execution_id === id);
  if (record) return jsonResponse(record);
  return jsonResponse({ error: `unhandled ${url}` }, 404);
};
const defaultFetch = (input: RequestInfo | URL) => fetchExecutions(input);
const fetchMock = vi.fn(defaultFetch);

const ownedRecords = [toolExecution, { ...jobExecution, correlation: { session_id: "session-2" } }, { ...kernelExecution, correlation: { session_id: "session-1" } }];

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="location">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>Browser back</button><button onClick={() => navigate(1)}>Browser forward</button></>;
}

function SessionRunsHarness() {
  const [params] = useSearchParams();
  return <>{params.get("view") === "runs" && <RunsPage sessionId="session-1" />}<LocationProbe /></>;
}

function renderPage(initial = "/workspace/project/runs") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/workspace/:cwd/runs" element={<><RunsPage /><LocationProbe /></>} />
          <Route path="/workspace/:cwd" element={<LocationProbe />} />
          <Route path="/workspace/:cwd/session/:sessionId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderSessionPage(initial = "/workspace/project/session/session-1?view=runs&execution=exec_tool") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/workspace/:cwd/session/:sessionId" element={<SessionRunsHarness />} />
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
  fetchMock.mockReset().mockImplementation(defaultFetch);
  toastMock.mockClear();
  openInspectorMock.mockClear();
  setDraftMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
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
    expect(screen.getByTestId("runs-workbench").parentElement).toHaveClass("runs-workbench-container");
    expect(await screen.findByText("agent-event-observer")).toBeInTheDocument();
    expect(screen.getAllByText("Running", { selector: "dd" }).length).toBeGreaterThan(0);
  });

  it("honors a deep-linked selection and updates it when another row is selected", async () => {
    renderPage("/workspace/project/runs?execution=exec_job");

    await screen.findByText("node-job-coordinator");
    expect(screen.getByText("Failed", { selector: "dd" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /analysis\.ipynb/ }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_kernel"));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "true");
    expect(await screen.findByText("node-kernel-gateway")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to executions" }));
    expect(screen.getByTestId("runs-workbench")).toHaveAttribute("data-compact-detail", "false");
  });

  it("filters by search text, kind, and status", async () => {
    renderPage();
    await screen.findAllByText("write");

    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "result.csv" } });
    await waitFor(() => {
      expect(screen.getByLabelText("location")).toHaveTextContent("search=result.csv");
      expect(screen.getByRole("button", { name: /analysis\.ipynb/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /node train\.js/ })).toBeNull();
    });

    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by execution type"), { target: { value: "job" } });
    await waitFor(() => {
      expect(screen.getByLabelText("location")).toHaveTextContent("kind=job");
      expect(screen.getByRole("button", { name: /node train\.js/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /analysis\.ipynb/ })).toBeNull();
    });

    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "succeeded" } });
    expect(await screen.findByText("No matching executions")).toBeInTheDocument();
  });

  it("shows input, files, artifacts, timing, and lazily loaded output", async () => {
    renderPage("/workspace/project/runs?execution=exec_kernel");
    await screen.findByText("node-kernel-gateway");

    fireEvent.click(screen.getByRole("tab", { name: "Input" }));
    expect(screen.getAllByText(/print\('ok'\)/, { selector: "pre" })[0]).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByText("data/input.csv")).toBeInTheDocument();
    expect(screen.getByText("outputs/result.csv")).toBeInTheDocument();
    expect(screen.getByText("artifact-result")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Timing" }));
    expect(screen.getAllByText("2.5 s").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Output" }));
    expect(await screen.findByText("kernel stdout")).toBeInTheDocument();
    expect(screen.getByText(/earlier output may have been truncated/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/executions/exec_kernel/logs"), expect.anything());
  });

  it("opens recorded files and resolves artifacts to their workspace file", async () => {
    renderPage("/workspace/project/runs?execution=exec_kernel");
    await screen.findByText("node-kernel-gateway");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    fireEvent.click(screen.getByRole("button", { name: /outputs\/result\.csv/ }));
    expect(openInspectorMock).toHaveBeenCalledWith(expect.objectContaining({ variant: "file", path: "outputs/result.csv", cwd: "/workspace" }));

    fireEvent.click(screen.getByRole("button", { name: /artifact-result/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/artifacts/artifact-result"), expect.anything()));
    expect(openInspectorMock).toHaveBeenLastCalledWith(expect.objectContaining({ path: "outputs/result.csv" }));
  });

  it("copies execution evidence and drafts a reproduction in the originating session", async () => {
    renderPage("/workspace/project/runs?execution=exec_tool");
    await screen.findByText("agent-event-observer");

    fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("exec_tool"));
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("write"));

    fireEvent.click(screen.getByRole("button", { name: "Ask AI to attempt reproduction" }));
    expect(setDraftMock).toHaveBeenCalledWith(expect.stringContaining("exec_tool"));
    expect(screen.getByLabelText("location")).toHaveTextContent("/workspace/%2Fworkspace/session/session-1");
  });

  it("locates correlated tool executions instead of offering a redundant session link", async () => {
    renderSessionPage();
    await screen.findByText("agent-event-observer");

    expect(screen.queryByRole("button", { name: "Open session" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Locate in conversation" }));

    await waitFor(() => {
      const location = screen.getByLabelText("location");
      expect(location).toHaveTextContent("focus=tool-call-1");
      expect(location).not.toHaveTextContent("view=runs");
      expect(location).not.toHaveTextContent("execution=");
    });
  });

  it("offers the session kernel from execution records only when kernel cells exist", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ executions: [{ ...kernelExecution, correlation: { session_id: "session-1" } }], total: 1, filtered_total: 1 }));
    renderSessionPage("/workspace/project/session/session-1?view=runs&execution=exec_kernel");
    const button = await screen.findByRole("button", { name: "Open session kernel" });

    fireEvent.click(button);

    expect(openInspectorMock).toHaveBeenCalledWith({ variant: "notebook-panel" });
  });

  it("surfaces failure evidence without requiring the output tab", async () => {
    renderPage("/workspace/project/runs?execution=exec_job");
    expect(await screen.findByText("Execution problem")).toBeInTheDocument();
    expect(screen.getAllByText("training failed")[0]).toBeInTheDocument();
    expect(screen.getByText(/exit code 1/)).toBeInTheDocument();
  });
});


describe("execution scope and timeline", () => {
  it("keeps session URL scope, allows workspace records, then restores the session", async () => {
    renderPage("/workspace/project/runs?session_id=session-1");
    await screen.findByText("agent-event-observer");
    expect(screen.queryByRole("button", { name: /node train\.js/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Execution scope")).toHaveValue("session");
    fireEvent.change(screen.getByLabelText("Execution scope"), { target: { value: "workspace" } });
    await screen.findByRole("button", { name: /node train\.js/ });
    expect(screen.getByLabelText("location")).toHaveTextContent("scope=workspace");
    expect(screen.getByLabelText("location")).toHaveTextContent("session_id=session-1");
    fireEvent.change(screen.getByLabelText("Execution scope"), { target: { value: "session" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /node train\.js/ })).not.toBeInTheDocument());
  });

  it("defaults workspace entry to all records and links timeline selections to details", async () => {
    renderPage();
    await screen.findByText("agent-event-observer");
    expect(screen.getByLabelText("Execution scope")).toHaveValue("workspace");
    fireEvent.click(screen.getByRole("button", { name: "Execution timeline" }));
    expect(screen.getByLabelText("Execution timeline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /node train\.js/ }));
    await screen.findByText("node-job-coordinator");
    expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_job");
  });

  it("requests older pages and resets paging when search changes", async () => {
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/executions?") && !new URL(url, "http://localhost").searchParams.get("search")) return jsonResponse({ executions: Array.from({ length: 50 }, (_, index) => ({ ...toolExecution, execution_id: `exec-page-${index}` })), total: 125, filtered_total: 125 });
      return defaultFetch(input);
    });
    renderPage();
    await screen.findByText("agent-event-observer");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("offset=50"), expect.anything()));
    fireEvent.change(screen.getByLabelText("Search executions"), { target: { value: "result.csv" } });
    await screen.findByRole("button", { name: /analysis\.ipynb/ });
    const lastListCall = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/executions?" )).at(-1);
    expect(String(lastListCall?.[0])).toContain("offset=0");
    expect(String(lastListCall?.[0])).toContain("search=result.csv");
  });

  it.each(["automatic", "clicked", "deep-link"])("ordinary paging selects the new page while explicit deep links stay pinned: %s", async (mode) => {
    const deepLink = mode === "deep-link";
    const first = { ...toolExecution, execution_id: "page-first" };
    const second = { ...jobExecution, execution_id: "page-second" };
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/executions") {
        const offset = Number(url.searchParams.get("offset") || 0);
        return jsonResponse({ executions: offset ? [second] : [first], total: 51, filtered_total: 51,
          target_in_scope: true, target_matches: true, target_offset: url.searchParams.get("target_id") === second.execution_id ? 50 : 0 });
      }
      if (url.pathname.endsWith("/page-first")) return jsonResponse(first);
      return defaultFetch(input);
    });
    renderPage(`/workspace/project/runs${deepLink ? "?execution=page-first" : ""}`);
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("execution=page-first"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    if (mode === "clicked") fireEvent.click(screen.getByRole("button", { name: /write/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(screen.getByLabelText("location")).toHaveTextContent("offset=50");
      expect(screen.getByLabelText("location")).toHaveTextContent(`execution=${deepLink ? "page-first" : "page-second"}`);
    });
    if (deepLink) expect(await screen.findByRole("button", { name: "Go to execution page" })).toBeInTheDocument();
    else {
      expect(screen.queryByRole("button", { name: "Go to execution page" })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("execution=page-first"));
    }
  });

  it("submits time bounds to the server and rejects a reversed range", async () => {
    renderPage();
    await screen.findByText("agent-event-observer");
    fireEvent.change(screen.getByLabelText("Window start"), { target: { value: "2026-08-15T01:00" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("from="), expect.anything()));
    fireEvent.change(screen.getByLabelText("Window end"), { target: { value: "2026-08-14T01:00" } });
    expect(screen.getByRole("alert")).toHaveTextContent("end time must be after");
  });
});

describe("review regressions", () => {
  it.each([75, 125])("keeps historical target %s outside the first page and can locate its page", async (position) => {
    const target = { ...kernelExecution, execution_id: `historical-${position}`, producer: `historical-producer-${position}` };
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === `/api/executions/${target.execution_id}`) return jsonResponse(target);
      if (url.pathname === "/api/executions") {
        const offset = Number(url.searchParams.get("offset") || 0);
        return jsonResponse({ executions: offset === Math.floor((position - 1) / 50) * 50 ? [target] : executions,
          total: 125, filtered_total: 125, target_offset: Math.floor((position - 1) / 50) * 50, target_matches: true, target_in_scope: true });
      }
      return defaultFetch(input);
    });
    renderPage(`/workspace/project/runs?execution=${target.execution_id}`);
    await screen.findByText(target.producer);
    expect(screen.getByLabelText("location")).toHaveTextContent(`execution=${target.execution_id}`);
    expect(await screen.findByText(/outside the current page/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Execution timeline" }));
    expect(screen.getByLabelText("location")).toHaveTextContent(`execution=${target.execution_id}`);
    fireEvent.click(screen.getByRole("button", { name: "Go to execution page" }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(`offset=${Math.floor((position - 1) / 50) * 50}`));
    expect(await screen.findByRole("button", { name: /analysis\.ipynb/ })).toBeInTheDocument();
  });

  it("keeps 4x zoom and collapsed groups without querying history on row selection", async () => {
    fetchMock.mockImplementation((input) => fetchExecutions(input, ownedRecords));
    renderPage("/workspace/project/runs?view=timeline");
    await screen.findByText("agent-event-observer");
    const timeline = screen.getByRole("region", { name: "Execution timeline" });
    const initialTimeline = timeline;
    const listCalls = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input), "http://localhost").pathname === "/api/executions");
    const count = listCalls().length;
    expect(count).toBe(1);
    fireEvent.click(within(timeline).getByRole("button", { name: "Zoom in" }));
    fireEvent.click(within(timeline).getByRole("button", { name: "Zoom in" }));
    const group = within(timeline).getByRole("button", { name: /session-2/ });
    fireEvent.click(group);
    for (const [label, producer] of [[/analysis\.ipynb/, "node-kernel-gateway"], [/write/, "agent-event-observer"], [/analysis\.ipynb/, "node-kernel-gateway"]] as const) {
      fireEvent.click(within(timeline).getByRole("button", { name: label }));
      await screen.findByText(producer);
      expect(screen.getByRole("region", { name: "Execution timeline" })).toBe(initialTimeline);
      expect(within(timeline).getByText("4×")).toBeInTheDocument();
      expect(group).toHaveAttribute("aria-expanded", "false");
      expect(within(timeline).queryByRole("button", { name: /node train\.js/ })).toBeNull();
      expect(listCalls()).toHaveLength(count);
    }
  });

  it.each([false, true])("resets ordinary selection across scope and filters but preserves explicit targets: %s", async (deepLink) => {
    fetchMock.mockImplementation((input) => fetchExecutions(input, ownedRecords));
    renderPage(`/workspace/project/runs?session_id=session-1&scope=workspace${deepLink ? "&execution=exec_job" : ""}`);
    await screen.findByText(deepLink ? "node-job-coordinator" : "agent-event-observer");
    if (!deepLink) {
      fireEvent.click(screen.getByRole("button", { name: /node train\.js/ }));
      await screen.findByText("node-job-coordinator");
    }
    fireEvent.change(screen.getByLabelText("Execution scope"), { target: { value: "session" } });
    await waitFor(() => {
      expect(screen.getByLabelText("location")).toHaveTextContent(`execution=${deepLink ? "exec_job" : "exec_tool"}`);
      expect(screen.getByRole("button", { name: /write/ })).toBeInTheDocument();
    });
    if (deepLink) expect(await screen.findByText(/outside the current scope or filters/)).toBeInTheDocument();
    else {
      await screen.findByText("agent-event-observer");
      expect(screen.queryByText("node-job-coordinator")).toBeNull();
      expect(screen.queryByText(/outside the current scope or filters/)).toBeNull();
    }
    fireEvent.change(screen.getByLabelText("Filter by execution type"), { target: { value: "kernel_cell" } });
    await waitFor(() => {
      expect(screen.getByLabelText("location")).toHaveTextContent("kind=kernel_cell");
      expect(screen.getByLabelText("location")).toHaveTextContent(`execution=${deepLink ? "exec_job" : "exec_kernel"}`);
    });
    if (!deepLink) await screen.findByText("node-kernel-gateway");
  });

  it("shows an explicit missing target and never substitutes the first record", async () => {
    renderPage("/workspace/project/runs?execution=missing");
    expect(await screen.findByRole("alert")).toHaveTextContent("Execution missing was not found");
    expect(screen.getByLabelText("location")).toHaveTextContent("execution=missing");
    expect(screen.getByLabelText("location")).not.toHaveTextContent("execution=exec_tool");
  });

  it("keeps an out-of-scope target and offers an explicit range adjustment", async () => {
    renderPage("/workspace/project/runs?session_id=session-1&execution=exec_job");
    await screen.findByText("node-job-coordinator");
    expect(await screen.findByText(/outside the current scope or filters/)).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_job");
    fireEvent.click(screen.getByRole("button", { name: "Show workspace and clear filters" }));
    await screen.findByRole("button", { name: /node train\.js/ });
    expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_job");
  });

  it("restores URL mode, paging, window and selection across browser navigation", async () => {
    renderPage("/workspace/project/runs?session_id=session-1&scope=workspace&view=timeline&execution=exec_job&from=2026-08-15T00%3A00%3A00Z&to=2026-08-16T00%3A00%3A00Z&offset=100");
    await screen.findByText("node-job-coordinator");
    expect(screen.getByRole("button", { name: "Execution timeline" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Window start")).toHaveValue("2026-08-15T00:00");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByLabelText("location")).toHaveTextContent("view=list");
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Execution timeline" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByLabelText("location")).toHaveTextContent("offset=100");
    expect(screen.getByLabelText("location")).toHaveTextContent("execution=exec_job");
    fireEvent.click(screen.getByRole("button", { name: "Browser forward" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("prioritizes session timeline and hides redundant grouping", async () => {
    renderPage("/workspace/project/runs?session_id=session-1");
    await screen.findByText("agent-event-observer");
    expect(screen.getByRole("button", { name: "Execution timeline" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Group by session (current page)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("timeline-canvas")).toHaveStyle({ width: "200%" });
    fireEvent.click(screen.getByRole("button", { name: "Fit range" }));
    expect(screen.getByTestId("timeline-canvas")).toHaveStyle({ width: "100%" });
  });

  it("shows code, results and actual output filenames without expanding raw JSON", async () => {
    renderPage("/workspace/project/runs?execution=exec_kernel");
    await screen.findByText("node-kernel-gateway");
    expect(screen.getByText(/^print\('ok'\).*2 \+ 2$/, { selector: "pre" })).toBeVisible();
    expect(screen.getByText(/^ok\s+4$/, { selector: "pre" })).toBeVisible();
    expect(screen.getByRole("button", { name: /outputs\/result\.csv/ })).toBeVisible();
    const raw = screen.getByText("Advanced: raw record").closest("details");
    expect(raw).not.toHaveAttribute("open");
  });
});


it.each(["constructor", "__proto__"])("uses the raw session ID %s when no real title is known", async (id) => {
  renderPage(`/workspace/project/runs?session_id=${id}`);
  await waitFor(() => expect(screen.getByLabelText("Execution scope")).toHaveValue("session"));
  expect(screen.getByText(`Current session · ${id}`)).toBeInTheDocument();
});
