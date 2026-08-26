// ScheduledTasksPage tests (docs §13): no N+1 on the initial task list, lazy
// run history per expansion, revision-conflict refetch, optimistic 202 manual
// run, server preview {local, utc} display, approval confirmation and the
// SQLite-degraded disabled state. All fetches are stubbed — no real network.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../../i18n";
import { queryClient } from "../../lib/client/query-client";
import type { ScheduledTaskView, TaskListSummary } from "../../lib/scheduled-tasks";
import { ScheduledTasksPage } from "./ScheduledTasksPage";

const { toastMock, openInspectorMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  openInspectorMock: vi.fn(),
}));

vi.mock("../../lib/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ui")>();
  return { ...actual, useUiStore: (selector: (state: { openInspector: typeof openInspectorMock }) => unknown) => selector({ openInspector: openInspectorMock }) };
});

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

const STATUS_OK = { status: "running", feature_enabled: true, last_tick_at: null, next_deadline_at: null, pending_attempts: 0, active_attempts: 0, expired_leases: 0, dispatcher_active: 0, dispatcher_limit: 2, last_error: null, sqlite_ready: true };

const summaries: TaskListSummary[] = Array.from({ length: 50 }, (_, index) => ({
  task_id: `stask_${index + 1}`,
  revision: index === 0 ? 3 : 1,
  name: index === 0 ? "Daily digest" : `Task ${index + 1}`,
  lifecycle_status: "active",
  schedule: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
  approval_status: "none",
  next_run_at: "2026-08-27T01:00:00Z",
  latest_run: null,
}));

const detail: ScheduledTaskView = {
  task_id: "stask_1",
  project_id: "proj",
  workspace_path: "/workspace",
  schema_version: 1,
  revision: 3,
  name: "Daily digest",
  lifecycle_status: "active",
  schedule: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
  executor: { kind: "literature_digest", config: { query: "single-cell RNA sequencing", providers: ["pubmed"], max_results: 30, language: "zh-CN" } },
  output: { relative_root: "outputs/digest" },
  approval: { status: "pending", scope_hash: "sha256_abc", approved_revision: 1, categories: ["dna-sequence"], terms: ["External provider terms apply"], approved_at: null },
  retry: { max_attempts: 3, initial_backoff_seconds: 30, multiplier: 4, max_backoff_seconds: 600 },
  budget: { max_wall_time_seconds: 900 },
  misfire_policy: "coalesce_latest",
  concurrency_policy: "forbid",
  next_run_at: null,
  last_scheduled_at: null,
  last_run_id: null,
  created_at: "2026-08-25T00:00:00Z",
  updated_at: "2026-08-25T00:00:00Z",
  deleted_at: null,
};

const runsPage = {
  items: [{
    run_id: "run_1",
    task_id: "stask_1",
    task_revision: 3,
    trigger_source: "automatic",
    scheduled_for: "2026-08-26T01:00:00Z",
    business_date: "2026-08-26",
    occurrence_key: "occ_1",
    status: "succeeded",
    snapshot: {},
    snapshot_sha256: "aa",
    latest_attempt_id: "satt_1",
    attempt_count: 2,
    output_paths: ["outputs/digest/report.md"],
    error_code: null,
    error_message: null,
    created_at: "2026-08-26T01:00:00Z",
    started_at: "2026-08-26T01:00:01Z",
    ended_at: "2026-08-26T01:05:00Z",
  }],
  next_cursor: null,
};

const attemptsPage = {
  items: [{
    attempt_id: "satt_2",
    run_id: "run_1",
    attempt_no: 2,
    status: "succeeded",
    available_at: "2026-08-26T01:03:00Z",
    execution_id: "exec_a2",
    output_paths: [],
    error_code: null,
    error_message: null,
    started_at: "2026-08-26T01:03:00Z",
    ended_at: "2026-08-26T01:05:00Z",
    created_at: "2026-08-26T01:03:00Z",
  }],
  next_cursor: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let patchStatus = 409;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/scheduled-tasks/status")) return jsonResponse(STATUS_OK);
  if (url.startsWith("/api/scheduled-tasks?")) return jsonResponse({ items: summaries, next_cursor: null });
  if (/\/api\/scheduled-tasks\/stask_\d+\?/.test(url)) {
    if (init?.method === "PATCH") {
      return patchStatus === 200
        ? jsonResponse({ ...detail, name: "Renamed" })
        : jsonResponse({ code: "SCHEDULED_TASK_REVISION_CONFLICT", error: "revision changed", request_id: "r9", details: {} }, patchStatus);
    }
    return jsonResponse(detail);
  }
  if (url.includes("/attempts?")) return jsonResponse(attemptsPage);
  if (url.includes("/runs?")) return jsonResponse(runsPage);
  if (url.endsWith("/run?cwd=%2Fworkspace")) return jsonResponse({ run: { run_id: "run_manual", task_id: "stask_1", status: "pending", trigger_source: "manual", latest_attempt: null } }, 202);
  if (url.includes("/preview")) return jsonResponse({ items: [{ local: "2026-08-26 09:00", utc: "2026-08-26T01:00:00.000Z" }] });
  if (url.includes("/approve")) return jsonResponse({ ...detail, approval: { ...detail.approval, status: "approved" } });
  return jsonResponse({ error: `unhandled ${url}` }, 404);
});

function listCalls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.startsWith("/api/scheduled-tasks?"));
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}{location.search}</output>;
}

function renderPage(initial = "/workspace/proj/scheduled-tasks") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/workspace/:cwd/scheduled-tasks" element={<><ScheduledTasksPage /><LocationProbe /></>} />
          <Route path="/workspace/:cwd/runs" element={<LocationProbe />} />
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
  toastMock.mockClear();
  openInspectorMock.mockClear();
  patchStatus = 409;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ScheduledTasksPage", () => {
  it("renders 50 tasks from exactly one list request with no /runs fan-out; runs load only after expanding a task", async () => {
    renderPage();

    await screen.findByText("Task 50");
    expect(screen.getByText("Daily digest")).toBeInTheDocument();
    // docs §13.4: one collection request, latest status comes from the summary.
    expect(listCalls()).toHaveLength(1);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/runs"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));
    await screen.findByText("Run history");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/stask_7/runs"), expect.anything()));
    expect(listCalls()).toHaveLength(1);
  });

  it("shows attempts with an execution deep link after selecting a run", async () => {
    renderPage("/workspace/proj/scheduled-tasks?task=stask_1");

    await screen.findByText("Run history");
    fireEvent.click(await screen.findByText("2026-08-26"));
    expect(await screen.findByText("exec_a2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /exec_a2/ }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/workspace/%2Fworkspace/runs?execution=exec_a2"));
  });

  it("refetches the authoritative revision on a 409 PATCH and shows the conflict without overwriting input", async () => {
    renderPage();
    await screen.findByText("Daily digest");

    fireEvent.click(screen.getAllByTitle("Edit")[0]);
    const nameInput = await screen.findByLabelText("Name");
    expect(nameInput).toHaveValue("Daily digest");
    fireEvent.change(nameInput, { target: { value: "Renamed locally" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed by someone else");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/stask_1"), expect.objectContaining({ method: "PATCH" }));
    // The invalidation refetched the collection instead of blindly re-PATCHing.
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
    expect(screen.getByLabelText("Name")).toHaveValue("Renamed locally");
  });

  it("optimistically inserts a pending run row after a 202 manual run", async () => {
    renderPage();
    await screen.findByText("Daily digest");

    fireEvent.click(screen.getByRole("button", { name: /Daily digest/ }));
    await screen.findByText(/Succeeded/);

    fireEvent.click(screen.getAllByTitle("Run now")[0]);
    const pendingRow = await screen.findByText("Pending");
    expect(pendingRow).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/stask_1/run"), expect.anything());
  });

  it("requires explicit confirmation before approving, then posts revision + scope hash + categories", async () => {
    renderPage();
    await screen.findByText("Daily digest");

    fireEvent.click(screen.getByRole("button", { name: /Daily digest/ }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Approval required");
    expect(banner).toHaveTextContent("dna-sequence");
    expect(banner).toHaveTextContent("External provider terms apply");
    expect(banner).toHaveTextContent("no longer applies");

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I understand the data categories/));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/stask_1/approve"), expect.anything()));
    const [, init] = fetchMock.mock.calls.find((call) => String(call[0]).includes("/approve")) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ expected_revision: 3, approval_scope_hash: "sha256_abc", categories: ["dna-sequence"] });
  });

  it("previews occurrences with both local and UTC lines from the server response", async () => {
    renderPage();
    await screen.findByText("Daily digest");

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Weekly digest" } });
    fireEvent.change(screen.getByLabelText("Query"), { target: { value: "CRISPR review" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview next fires" }));
    const preview = await screen.findByTestId("schedule-preview");
    expect(preview).toHaveTextContent("2026-08-26 09:00");
    expect(preview).toHaveTextContent("2026-08-26 01:00 UTC");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/preview"), expect.anything());
  });

  it("disables creation while the SQLite-backed scheduler is unavailable (503 status)", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/scheduled-tasks/status")) return jsonResponse({ code: "SCHEDULED_TASKS_SQLITE_DISABLED", error: "unavailable", request_id: "r1", details: {} }, 503);
      return jsonResponse({ items: [], next_cursor: null });
    });

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
  });
});
