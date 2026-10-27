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
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  requests = [];
  stale = false;
  browsing = false;
  recordRows = [record];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, search: url.search, method, body });
      let data: unknown = {};
      let status = 200;
      if (url.pathname.endsWith("/settings"))
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
        data = { records: recordRows, proposals: [] };
      else if (url.pathname.endsWith("/background-runs")) data = { runs: [] };
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
function mount(initialEntry = "/workspace/project/memory") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
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
  fireEvent.click(
    screen.getByLabelText("View memory: Result includes limitations"),
  );
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
    screen.getByRole("combobox", { name: "Source type" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("textbox", {
      name: "File path, sessionId@messageId, Run ID or Artifact ID",
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
  expect(screen.getByText("file: result.txt")).toBeVisible();
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
