import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { settingsSchema } from "@pi-science/contracts";
import i18n from "../../i18n";
import { MemoryPage } from "./MemoryPage";
import { useUiStore } from "../../lib/ui";
const record = {
  id: "r1",
  scope: "project",
  kind: "finding",
  title: "Result includes limitations",
  body: "Preliminary result",
  status: "pending_review",
  reviewStatus: "pending",
  revision: 3,
  contentHash: "hash-3",
  ownerId: "local-owner",
  projectId: "project-id",
  origin: "agent_tool",
  evidenceLevel: "observed",
  reviewRequired: true,
  createdAt: 1000,
  updatedAt: 2000,
  sources: [{ kind: "file", locator: "result.txt" }],
};
let requests: Array<{
  path: string;
  search: string;
  method: string;
  body: any;
}>;
let stale: boolean;
let browsing: boolean;
let recordRows: (typeof record)[];
let runRows: unknown[];
let proposalRows: unknown[];
let editResult: unknown;
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  requests = [];
  stale = false;
  browsing = false;
  recordRows = [record];
  runRows = [];
  proposalRows = [];
  editResult = {};
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, search: url.search, method, body });
      let data: unknown = {};
      let status = 200;
      if (method === "PATCH" && url.pathname.endsWith("/records/r1"))
        data = editResult;
      else if (url.pathname.endsWith("/settings"))
        data = { ...settingsSchema.parse({ enabled: true }), revision: 1 };
      else if (url.pathname.endsWith("/records"))
        data = browsing
          ? {
              records: recordRows,
              total: 45,
              page: Number(url.searchParams.get("page") ?? 1),
              pageSize: 20,
              totalPages: 3,
            }
          : {
              records: recordRows,
              total: recordRows.length,
              page: 1,
              pageSize: 20,
              totalPages: 1,
            };
      else if (url.pathname.endsWith("/reviews"))
        data = {
          records: recordRows.filter((r) => r.status !== "active"),
          proposals: proposalRows,
        };
      else if (url.pathname.endsWith("/background-runs"))
        data = { runs: runRows };
      else if (url.pathname.endsWith("/categories"))
        data = {
          categories: browsing ? [{ id: "cat1", name: "Writing" }] : [],
        };
      else if (url.pathname.endsWith("/project-settings"))
        data = { autoRecall: true };
      else if (url.pathname.endsWith("/approve") && stale) {
        status = 409;
        data = { error: "Memory revision changed" };
      }
      return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(initialEntry = "/workspace/project/memory", navigation = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        {navigation && (
          <Link to="/workspace/other-project/memory">Switch project</Link>
        )}
        <Routes>
          <Route path="/workspace/:cwd/memory" element={<MemoryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it("shows one Memory product with three sections and labeled scientific candidates", async () => {
  mount();
  expect(
    await screen.findByText("Result includes limitations"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("navigation", { name: "Memory" }),
  ).toBeInTheDocument();
  for (const name of ["Memories", "Pending review (1)", "Run history"])
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  expect(requests.every((r) => r.path.startsWith("/api/memory/"))).toBe(true);
});
it("submits approval for the displayed exact version and shows a 409 instead of reporting success", async () => {
  mount();
  await screen.findByText("Result includes limitations");
  fireEvent.click(screen.getByRole("button", { name: "Pending review (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
  await screen.findByRole("dialog", { name: "Result includes limitations" });
  stale = true;
  fireEvent.click(screen.getByRole("button", { name: "Approve this version" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Memory revision changed",
  );
  expect(requests.find((r) => r.path.endsWith("/approve"))?.body).toEqual({
    expectedRevision: 3,
    contentHash: "hash-3",
  });
});
it("opens the application Memory settings directly and keeps project recall on the Memory page", async () => {
  mount();
  await screen.findByText("Result includes limitations");
  expect(
    screen.queryByRole("button", { name: "Settings" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Memory settings" }));
  expect(useUiStore.getState()).toMatchObject({
    settingsOpen: true,
    settingsScope: "project",
    settingsSection: "memory",
  });
  expect(
    screen.getByLabelText("Allow recall in this project"),
  ).toBeInTheDocument();
});

it("provides source fields for manually entered memories", async () => {
  mount();
  await screen.findByText("Result includes limitations");
  fireEvent.click(screen.getByRole("button", { name: "Create memory" }));
  fireEvent.click(screen.getByRole("button", { name: "Add source" }));
  expect(
    screen.getByRole("button", { name: "Source type: File" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("textbox", {
      name: "File path",
    }),
  ).toBeInTheDocument();
});

it("keeps sources and history inside expandable details", async () => {
  mount();
  await screen.findByText("Result includes limitations");
  expect(
    screen.getByRole("button", { name: "Version and review history" }),
  ).not.toBeVisible();
  const summary = screen.getByLabelText(
    "View memory: Result includes limitations",
  );
  fireEvent.click(summary);
  expect(
    screen.getByRole("button", { name: "Version and review history" }),
  ).toBeVisible();
  expect(screen.getAllByText("result.txt")[0]).toBeVisible();
  fireEvent.click(summary);
  expect(
    screen.getByRole("button", { name: "Version and review history" }),
  ).not.toBeVisible();
});
it("archives from the more-actions menu using the current version", async () => {
  mount();
  await screen.findByText("Result includes limitations");
  expect(
    screen.queryByRole("button", { name: "Archive" }),
  ).not.toBeInTheDocument();
  const more = screen.getByRole("button", {
    name: "More actions: Result includes limitations",
  });
  fireEvent.pointerDown(more);
  fireEvent.click(more);
  expect(
    await screen.findByRole("menuitem", { name: "Permanently delete" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
  await screen.findByRole("status");
  expect(requests.find((r) => r.path.endsWith("/archive"))?.body).toEqual({
    expectedRevision: 3,
    contentHash: "hash-3",
  });
});

it("requests server-side filters, sorting and pagination, resetting page after a change", async () => {
  browsing = true;
  mount("/workspace/project/memory?page=3");
  await screen.findByText("Page 3 of 3");
  expect(screen.getByText("45 memories")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Page 2 of 3");
  const choose = async (label: string, option: string) => {
    const trigger = screen.getByRole("button", {
      name: new RegExp("^" + label + ":"),
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: option }));
  };
  await choose("Status", "Active");
  await screen.findByText("Page 1 of 3");
  await choose("Type", "Preference");
  await choose("Scope", "Project");
  await choose("Category", "Writing");
  fireEvent.change(screen.getByRole("textbox", { name: "Search memories" }), {
    target: { value: "中文" },
  });
  await screen.findByRole("button", { name: "Sort: Relevance" });
  await choose("Sort", "Recently created");
  await waitFor(() => {
    const params = new URLSearchParams(
      requests.filter((r) => r.path.endsWith("/records")).at(-1)!.search,
    );
    expect(Object.fromEntries(params)).toMatchObject({
      q: "中文",
      status: "active",
      kind: "preference",
      scope: "project",
      categoryId: "cat1",
      sort: "created_desc",
      page: "1",
      pageSize: "20",
    });
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
  await screen.findByRole("button", { name: "Sort: Recently updated" });
  expect(screen.getByRole("textbox", { name: "Search memories" })).toHaveValue(
    "",
  );
  await waitFor(() => {
    const params = new URLSearchParams(
      requests.filter((r) => r.path.endsWith("/records")).at(-1)!.search,
    );
    expect(params.has("status")).toBe(false);
    expect(params.has("categoryId")).toBe(false);
    expect(params.get("page")).toBe("1");
  });
});

it("opens editing in a focused modal and resets the draft when switching records", async () => {
  recordRows = [
    record,
    { ...record, id: "r2", title: "Second record", body: "Different body" },
  ];
  mount();
  await screen.findByText("Second record");
  const edit = async (title: string) => {
    const trigger = screen.getByRole("button", {
      name: "More actions: " + title,
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  };
  await edit(record.title);
  const first = await screen.findByRole("dialog", {
    name: "Edit memory: " + record.title,
  });
  const title = within(first).getByRole("textbox", { name: "Title" });
  await waitFor(() => expect(title).toHaveFocus());
  fireEvent.change(within(first).getByRole("textbox", { name: "Body" }), {
    target: { value: "Unsaved first draft" },
  });
  fireEvent.click(within(first).getByRole("button", { name: "Close" }));
  await waitFor(() => {
    expect(
      screen.getByRole("button", {
        name: "More actions: " + record.title,
      }),
    ).toHaveFocus();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });
  await edit("Second record");
  const second = await screen.findByRole("dialog", {
    name: "Edit memory: Second record",
  });
  expect(within(second).getByRole("textbox", { name: "Title" })).toHaveValue(
    "Second record",
  );
  expect(within(second).getByRole("textbox", { name: "Body" })).toHaveValue(
    "Different body",
  );
});

it("distinguishes measured usage, estimates and holds and displays safe retry diagnostics", async () => {
  runRows = [
    {
      id: "cancelled-run",
      kind: "dream",
      status: "cancelled",
      createdAt: 1,
      usage: {
        measuredTokens: 10,
        measuredCostUsd: 0.001,
        estimatedTokens: 1000,
        estimatedCostUsd: 0.1,
        reservedTokens: 0,
        reservedCostUsd: 0,
      },
      diagnostic: {
        code: "ENOENT",
        stage: "workspace",
        failureCount: 2,
        nextScanAt: 100000,
      },
    },
  ];
  mount();
  await screen.findByText("Result includes limitations");
  fireEvent.click(screen.getByRole("button", { name: "Run history" }));
  expect(
    await screen.findByText(
      "Budget total (includes estimates / reservations): $0.101",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Measured usage: $0.00")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("View details"));
  expect(screen.getByText("10 tokens · $0.001")).toBeVisible();
  expect(screen.getByText("1000 tokens · $0.10")).toBeVisible();
  expect(
    screen.getByText(/workspace · ENOENT · failures: 2/),
  ).toHaveTextContent("Next retry");
  expect(
    screen.queryByRole("button", { name: "Stop" }),
  ).not.toBeInTheDocument();
});

it("opens a complete change review and approves the displayed proposal hash/revision", async () => {
  proposalRows = [
    {
      id: "p1",
      recordId: "r1",
      expectedRevision: 3,
      expectedHash: "hash-3",
      contentHash: "candidate-hash",
      status: "pending",
      reason: "Updated evidence",
      current: { ...record, status: "active" },
      candidate: {
        ...record,
        revision: 4,
        title: "Revised result",
        body: "New limitations",
        status: "pending_review",
      },
    },
  ];
  mount();
  await screen.findByText("Result includes limitations");
  fireEvent.click(screen.getByRole("button", { name: "Pending review (2)" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  const modal = await screen.findByRole("dialog", { name: "Revised result" });
  expect(within(modal).getByText("Current version")).toBeVisible();
  expect(within(modal).getByText("New limitations")).toBeVisible();
  fireEvent.click(
    within(modal).getByRole("button", { name: "Approve this version" }),
  );
  await waitFor(() =>
    expect(
      requests.find((r) => r.path.endsWith("/proposals/p1/accept"))?.body,
    ).toEqual({ expectedRevision: 3, contentHash: "candidate-hash" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
it.each(["stale_proposal", "revision_changed", "missing_current"])(
  "blocks unsafe approval in the review dialog: %s",
  async (reason) => {
    proposalRows = [
      {
        id: "p1",
        recordId: "r1",
        expectedRevision: 3,
        contentHash: "candidate-hash",
        status: reason === "stale_proposal" ? reason : "pending",
        reason: "Review",
        current:
          reason === "missing_current"
            ? undefined
            : { ...record, revision: reason === "revision_changed" ? 4 : 3 },
        candidate: { ...record, title: "Revised result" },
      },
    ];
    mount();
    await screen.findByText("Result includes limitations");
    fireEvent.click(screen.getByRole("button", { name: "Pending review (2)" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const modal = await screen.findByRole("dialog", { name: "Revised result" });
    expect(
      within(modal).getByRole("button", { name: "Approve this version" }),
    ).toBeDisabled();
    expect(within(modal).getByRole("button", { name: "Reject" })).toBeEnabled();
  },
);
it("keeps an unsaved editor open when discard is declined", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false),
  );
  mount();
  await screen.findByText("Result includes limitations");
  fireEvent.click(screen.getByRole("button", { name: "Create memory" }));
  const dialog = await screen.findByRole("dialog", { name: "Create memory" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), {
    target: { value: "Draft" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(dialog).toBeVisible();
  expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue(
    "Draft",
  );
  expect(window.confirm).toHaveBeenCalledWith("Discard unsaved changes?");
});

it.each([true, false])(
  "reports scientific edit review state and clears it when switching projects: %s",
  async (proposed) => {
    const active = { ...record, status: "active", reviewStatus: "approved" };
    recordRows = [active];
    const candidate = {
      ...active,
      body: "Revised scientific interpretation",
      revision: 4,
      contentHash: "hash-4",
    };
    const proposal = {
      id: "edit-proposal",
      recordId: "r1",
      expectedRevision: 3,
      contentHash: "hash-4",
      status: "pending",
      candidate,
      current: active,
    };
    editResult = proposed
      ? { proposal, record: active }
      : { record: candidate };
    if (proposed) proposalRows = [proposal];
    mount("/workspace/project/memory", true);
    const trigger = await screen.findByRole("button", {
      name: "More actions: " + record.title,
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit memory: " + record.title,
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Body" }), {
      target: { value: candidate.body },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      proposed ? "Submitted for review; current version unchanged." : "Saved",
    );
    expect(
      requests.find(
        (r) => r.method === "PATCH" && r.path.endsWith("/records/r1"),
      )?.body,
    ).toMatchObject({
      expectedRevision: 3,
      contentHash: "hash-3",
      content: { body: candidate.body },
    });
    if (proposed) {
      expect(screen.getAllByText(record.body)[0]).toBeVisible();
      expect(screen.queryByText("Saved")).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "View pending review" }),
      );
      expect(
        await screen.findByRole("button", {
          name: /Pending review/,
          pressed: true,
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Review changes" }),
      ).toBeVisible();
    } else {
      expect(
        screen.queryByRole("button", { name: "View pending review" }),
      ).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("link", { name: "Switch project" }));
    await waitFor(() => {
      expect(
        requests.some(
          (r) =>
            new URLSearchParams(r.search).get("cwd") === "other-project" &&
            r.path.endsWith("/records"),
        ),
      ).toBe(true);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View pending review" }),
    ).not.toBeInTheDocument();
  },
);

it("clears the previous project's error and review dialog when switching projects", async () => {
  mount("/workspace/project/memory", true);
  await screen.findByText(record.title);
  fireEvent.click(screen.getByRole("button", { name: "Pending review (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
  await screen.findByRole("dialog", { name: record.title });
  stale = true;
  fireEvent.click(screen.getByRole("button", { name: "Approve this version" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Memory revision changed",
  );
  // Close the modal so navigation uses the same route component, as in the app.
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Memory revision changed",
  );
  fireEvent.click(screen.getByRole("link", { name: "Switch project" }));
  await waitFor(() => {
    expect(
      requests.some(
        (r) =>
          new URLSearchParams(r.search).get("cwd") === "other-project" &&
          r.path.endsWith("/records"),
      ),
    ).toBe(true);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
