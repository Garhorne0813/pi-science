import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../../i18n";
import { queryClient } from "../../lib/client/query-client";
import type { ScheduledTask, ScheduledTaskRun } from "../../lib/scheduled-tasks";
import { ScheduledTasksPage } from "./ScheduledTasksPage";

const { toastMock, confirmMock, openInspectorMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  confirmMock: vi.fn(async () => true),
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
  useFeedback: () => ({ toast: toastMock, confirm: confirmMock }),
}));

vi.mock("../../components/layout/WorkspacePage", () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WorkspacePageHeader: ({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) => <header>{title}{description}{actions}</header>,
  WorkspacePageRefreshButton: ({ label, onClick }: { label: string; onClick: () => void }) => <button onClick={onClick}>{label}</button>,
}));

const taskA: ScheduledTask = {
  task_id: "task-a",
  schema_version: 1,
  revision: 3,
  name: "ArXiv daily digest",
  type: "literature_digest",
  enabled: true,
  schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
  executor: { kind: "headless_agent", config: { query: "LLM agents memory", instructions: "only last 7 days" } },
  output: { relative_path: "reports/literature/task-a/" },
  approval: { status: "none", content_hash: "h-a", revision: 3, categories: [], terms: [], updated_at: null },
  retry: { max_attempts: 2 },
  next_run_at: "2030-01-01T01:00:00.000Z",
  last_run_at: "2026-08-15T01:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-15T01:00:00.000Z",
};

const taskB: ScheduledTask = {
  ...taskA,
  task_id: "task-b",
  name: "Sensitive watch",
  enabled: false,
  schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
  approval: { status: "pending", content_hash: "h-b", revision: 1, categories: ["clinical-identifier"], terms: ["patient cohort"], updated_at: "2026-08-14T00:00:00.000Z" },
  next_run_at: null,
  last_run_at: null,
};

const runA: ScheduledTaskRun = {
  run_id: "run-a",
  task_id: "task-a",
  scheduled_for: "2026-08-15T01:00:00.000Z",
  trigger: "cron",
  idempotency_key: "task-a:2026-08-15T01:00:00Z",
  status: "succeeded",
  attempt: 0,
  execution_id: "exec-1",
  started_at: "2026-08-15T01:00:00.000Z",
  ended_at: "2026-08-15T01:02:00.000Z",
  output_paths: ["reports/literature/task-a/2026-08-15.md"],
  error: null,
  usage: { model_tokens: 1234, cost_usd: 0.1234 },
};

const runB: ScheduledTaskRun = {
  ...runA,
  run_id: "run-b",
  task_id: "task-b",
  status: "needs_attention",
  output_paths: [],
  error: "query matches sensitive terms",
  usage: { model_tokens: 0, cost_usd: 0 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (method === "GET" && url.startsWith("/api/scheduled-tasks?cwd=")) return jsonResponse({ tasks: [taskA, taskB] });
  if (method === "GET" && url.includes("/runs/run-a?")) return jsonResponse({ ...runA, log_tail: "agent log tail line" });
  if (method === "GET" && url.includes("/runs?")) {
    const taskId = url.match(/\/api\/scheduled-tasks\/([^/]+)\/runs\?/)?.[1];
    if (taskId === "task-a") return jsonResponse({ runs: [runA] });
    if (taskId === "task-b") return jsonResponse({ runs: [runB] });
    return jsonResponse({ runs: [] });
  }
  if (method === "POST" && url.includes("/preview?")) {
    return jsonResponse({ valid: true, error: null, timezone: "Asia/Shanghai", next_runs: ["2030-01-01T01:00:00.000Z", "2030-01-02T01:00:00.000Z", "2030-01-03T01:00:00.000Z", "2030-01-04T01:00:00.000Z", "2030-01-05T01:00:00.000Z"] });
  }
  if (method === "POST" && url.startsWith("/api/scheduled-tasks?cwd=")) {
    const body = JSON.parse(String(init?.body)) as ScheduledTask;
    return jsonResponse({ ...taskA, task_id: "task-new", name: body.name, approval: { status: "pending", content_hash: "h-new", revision: 1, categories: [], terms: [], updated_at: null } });
  }
  if (method === "POST" && url.includes("/run?")) return jsonResponse({ ...runA, run_id: "run-manual", trigger: "manual" });
  if (method === "POST" && url.includes("/approve?")) return jsonResponse({ ...taskB, approval: { status: "approved", content_hash: "h-b", revision: 1, categories: taskB.approval.categories, terms: taskB.approval.terms, updated_at: "2026-08-15T02:00:00.000Z" } });
  if (method === "PATCH" && url.includes("/task-a?")) {
    const body = JSON.parse(String(init?.body)) as Partial<ScheduledTask>;
    return jsonResponse({ ...taskA, enabled: body.enabled ?? taskA.enabled });
  }
  if (method === "DELETE" && url.includes("/task-a?")) return jsonResponse({ ok: true });
  return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
}

const fetchMock = vi.fn();

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/workspace/project/scheduled-tasks"]}>
        <Routes>
          <Route path="/workspace/:cwd/scheduled-tasks" element={<ScheduledTasksPage />} />
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
  fetchMock.mockImplementation(defaultFetch);
  fetchMock.mockClear();
  toastMock.mockClear();
  confirmMock.mockClear();
  openInspectorMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ScheduledTasksPage task list", () => {
  it("renders tasks with schedule, last-run status and actions", async () => {
    renderPage();

    expect(await screen.findByText("ArXiv daily digest")).toBeInTheDocument();
    expect(screen.getByText("Sensitive watch")).toBeInTheDocument();
    expect(screen.getAllByText("Literature digest").length).toBeGreaterThanOrEqual(2);
    // Next run carries the absolute time and timezone in the title.
    expect(screen.getByTitle(/Asia\/Shanghai/)).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect((await screen.findAllByText("Succeeded")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Needs attention")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Run now" }).length).toBe(2);
    // Paused task switch reflects the disabled state.
    expect(screen.getAllByRole("switch")[1]).toHaveAttribute("aria-checked", "false");
  });

  it("shows the empty state with a create button when no tasks exist", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ tasks: [] }));
    renderPage();

    expect(await screen.findByText("No scheduled tasks yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create your first scheduled task" })).toBeInTheDocument();
  });
});

describe("ScheduledTasksPage actions", () => {
  it("triggers a manual run and toasts the outcome", async () => {
    renderPage();
    await screen.findByText("ArXiv daily digest");

    fireEvent.click(screen.getAllByRole("button", { name: "Run now" })[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/task-a/run?"), expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("Run triggered", "success"));
  });

  it("toasts the reason when a manual run is skipped", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.startsWith("/api/scheduled-tasks?cwd=")) return jsonResponse({ tasks: [taskA, taskB] });
      if (method === "GET" && url.includes("/runs?")) return jsonResponse({ runs: [] });
      if (method === "POST" && url.includes("/run?")) return jsonResponse({ ...runA, run_id: "run-skipped", status: "skipped", error: "overlapping run" });
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    renderPage();
    await screen.findByText("ArXiv daily digest");

    fireEvent.click(screen.getAllByRole("button", { name: "Run now" })[0]);

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("Run skipped: overlapping run", "error"));
  });

  it("pauses an enabled task through the switch", async () => {
    renderPage();
    await screen.findByText("ArXiv daily digest");

    fireEvent.click(screen.getAllByRole("switch")[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/task-a?"), expect.objectContaining({ method: "PATCH" })));
    const patch = fetchMock.mock.calls.find((call) => String(call[0]).includes("/task-a?"))?.[1];
    expect(JSON.parse(String((patch as RequestInit | undefined)?.body))).toEqual({ enabled: false });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("Task paused", "success"));
  });

  it("deletes a task after confirmation", async () => {
    renderPage();
    await screen.findByText("ArXiv daily digest");
    fireEvent.click(screen.getByRole("button", { name: /ArXiv daily digest/ }));
    await screen.findByText("Run history");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ destructive: true })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/task-a?"), expect.objectContaining({ method: "DELETE" })));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("Task deleted", "success"));
  });
});

describe("ScheduledTasksPage create form", () => {
  it("creates a task with the expected payload and hints about approval", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Daily Digest" } });
    fireEvent.change(screen.getByLabelText("Query"), { target: { value: "new papers on LLM" } });
    fireEvent.change(screen.getByLabelText("Instructions (optional)"), { target: { value: "group by topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Weekdays" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks?cwd="), expect.objectContaining({ method: "POST" })));
    const post = fetchMock.mock.calls.find((call) => String(call[0]).startsWith("/api/scheduled-tasks?") && (call[1] as RequestInit | undefined)?.method === "POST")?.[1];
    expect(JSON.parse(String((post as RequestInit | undefined)?.body))).toEqual({
      name: "Daily Digest",
      type: "literature_digest",
      schedule: { cron: "0 9 * * 1-5", timezone: expect.any(String) },
      executor: { kind: "headless_agent", config: { query: "new papers on LLM", instructions: "group by topic" } },
      output: { relative_path: "reports/literature/daily-digest/" },
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("Task created", "success"));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("The query matches sensitive terms; the task runs only after approval", "info"));
  });

  it("shows a live cron preview and blocks saving an invalid cron", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hourly job" } });
    fireEvent.change(screen.getByLabelText("Query"), { target: { value: "anything" } });
    expect(screen.getByText("每天 09:00")).toBeInTheDocument();
    expect(screen.getByText(/Next 5 triggers/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Custom cron"), { target: { value: "99 * * * *" } });
    expect(screen.getByText("Invalid cron expression")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("calls the server preview API on cron input and renders the server next runs", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByRole("button", { name: "New task" }));

      fireEvent.change(screen.getByLabelText("Custom cron"), { target: { value: "0 8 * * *" } });
      expect(screen.getAllByText(/Computing/).length).toBeGreaterThan(0);

      await act(async () => { vi.advanceTimersByTime(300); });
      await act(async () => { await Promise.resolve(); });

      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/preview?"), expect.objectContaining({ method: "POST" }));
      const previewCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/preview?"))?.[1];
      expect(JSON.parse(String((previewCall as RequestInit | undefined)?.body))).toEqual({ cron: "0 8 * * *", timezone: expect.any(String) });
      expect(screen.queryByText(/Computing/)).not.toBeInTheDocument();
      const items = document.querySelectorAll("li");
      expect(items).toHaveLength(5);
      const expected = new Date("2030-01-01T01:00:00.000Z").toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      expect(items[0]).toHaveTextContent(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the local preview when the preview API fails, without a toast", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/preview?")) return jsonResponse({ error: "boom" }, 500);
      return defaultFetch(input, init);
    });
    try {
      renderPage();
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByRole("button", { name: "New task" }));
      fireEvent.change(screen.getByLabelText("Custom cron"), { target: { value: "0 8 * * *" } });

      await act(async () => { vi.advanceTimersByTime(300); });
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByText("Preview failed to load — showing a local estimate")).toBeInTheDocument();
      expect(document.querySelectorAll("li").length).toBeGreaterThan(0); // local fallback estimate
      expect(toastMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ScheduledTasksPage detail and history", () => {
  it("shows the configuration summary, approval banner and approves a pending task", async () => {
    renderPage();
    await screen.findByText("Sensitive watch");
    fireEvent.click(screen.getByRole("button", { name: /Sensitive watch/ }));

    expect(await screen.findByText(/每周一至周五 09:00/)).toBeInTheDocument();
    expect(screen.getByText(/\(0 9 \* \* 1-5\)/)).toBeInTheDocument();
    expect(screen.getByText("LLM agents memory")).toBeInTheDocument();
    expect(screen.getByText("The query matches sensitive terms. The task runs only after you approve it.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/task-b/approve?"), expect.objectContaining({ method: "POST" })));
    const approve = fetchMock.mock.calls.find((call) => String(call[0]).includes("/approve?"))?.[1];
    expect(JSON.parse(String((approve as RequestInit | undefined)?.body))).toEqual({ categories: taskB.approval.categories });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("Approved — the task can now run", "success"));
  });

  it("lists run history and shows the log tail of the selected run", async () => {
    renderPage();
    await screen.findByText("ArXiv daily digest");
    fireEvent.click(screen.getByRole("button", { name: /ArXiv daily digest/ }));

    expect(await screen.findByText("Run history")).toBeInTheDocument();
    expect((await screen.findAllByText("Schedule")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Attempt 0")).toBeInTheDocument();
    expect(await screen.findByText("1234 tokens · $0.1234")).toBeInTheDocument();
    expect(await screen.findByText("reports/literature/task-a/2026-08-15.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Attempt 0/ }));
    expect(await screen.findByText("agent log tail line")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/scheduled-tasks/task-a/runs/run-a?"), expect.anything());
  });
});
