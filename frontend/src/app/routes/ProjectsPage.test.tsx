import { createRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import { apiRequest } from "../../lib/client/api";
import i18n from "../../i18n";
import { ProjectsPage, sortProjects, WorkspaceCard } from "./ProjectsPage";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function Harness({ viewMode = "grid", togglePin = vi.fn() }: { viewMode?: "grid" | "list"; togglePin?: (path: string) => void }) {
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  return (
    <>
      <WorkspaceCard
        w={{ name: "Climate Study", path: "/tmp/Climate Study", project_id: "project-1", session_count: 2, last_modified: "2026-09-10T00:00:00Z" }}
        pinned={new Set()}
        togglePin={togglePin}
        editingName={editingName}
        setEditingName={setEditingName}
        editValue={editValue}
        setEditValue={setEditValue}
        handleRename={vi.fn()}
        handleDelete={vi.fn()}
        nameInputRef={createRef<HTMLInputElement>()}
        navigate={vi.fn()}
        timeAgo={() => "recently"}
        viewMode={viewMode}
      />
      <LocationProbe />
    </>
  );
}

describe("WorkspaceCard", () => {
  it("opens the workspace through a native full-card link", () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);

    const link = screen.getByRole("link", { name: "Open Climate Study" });
    expect(link).toHaveAttribute("href", "/workspace/%2Ftmp%2FClimate%20Study");

    fireEvent.click(link);
    expect(screen.getByTestId("location")).toHaveTextContent("/workspace/%2Ftmp%2FClimate%20Study");
  });

  it("keeps pinning separate from navigation in list mode", () => {
    const togglePin = vi.fn();
    render(<MemoryRouter><Harness viewMode="list" togglePin={togglePin} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Pin to top" }));
    expect(togglePin).toHaveBeenCalledWith("/tmp/Climate Study");
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });
});

describe("sortProjects", () => {
  const projects = [
    { name: "Beta", path: "/beta", project_id: "2", session_count: 8, last_modified: "2026-09-01T10:00:00Z" },
    { name: "alpha", path: "/alpha", project_id: "1", session_count: 2, last_modified: "2026-09-12T10:00:00Z" },
    { name: "Gamma", path: "/gamma", project_id: "3", session_count: 5, last_modified: "2026-09-05T10:00:00Z" },
  ];
  it("sorts by activity without mutating the input", () => {
    expect(sortProjects(projects, "recent").map(p => p.name)).toEqual(["alpha", "Gamma", "Beta"]);
    expect(projects[0].name).toBe("Beta");
  });
  it("prefers actual activity over a newer root-directory modification", () => {
    const active = { ...projects[0], last_activity_at: "2026-09-20T10:00:00Z" };
    expect(sortProjects([projects[1], active], "recent")[0]).toBe(active);
  });
  it("sorts names and conversation count", () => {
    expect(sortProjects(projects, "name").map(p => p.name)).toEqual(["alpha", "Beta", "Gamma"]);
    expect(sortProjects(projects, "sessions").map(p => p.name)).toEqual(["Beta", "Gamma", "alpha"]);
  });
});

vi.mock("../../lib/client/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/client/api")>(),
  apiRequest: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ProjectsPage loading", () => {
  function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
    render(
      <QueryClientProvider client={client}>
        <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
          <MemoryRouter><ProjectsPage /></MemoryRouter>
        </FeedbackContext.Provider>
      </QueryClientProvider>,
    );
    return client;
  }

  it("hides overview and empty states on API failure, then restores them after retry", async () => {
    let failed = true;
    vi.mocked(apiRequest).mockImplementation(async (path) => {
      if (path === "/api/workspaces/pinned") return { paths: [] };
      if (failed) throw new Error("Service unavailable");
      return [{ name: "Recovered", path: "/recovered", project_id: "1", session_count: 3, last_modified: "2026-09-01T00:00:00Z", last_activity_at: "2026-09-12T00:00:00Z" }];
    });
    const client = renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("projects.loadError"));
    for (const key of ["projects.totalProjects", "projects.totalSessions", "projects.pinnedProjects", "projects.startHere", "projects.emptyTitle"]) {
      expect(screen.queryAllByText(i18n.t(key)).filter(element => element.tagName !== "H1")).toHaveLength(0);
    }
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: i18n.t("common.refresh") }));
    expect(await screen.findByRole("link", { name: "Open Recovered" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByText(i18n.t("projects.totalProjects")).some(element => element.tagName === "P")).toBe(true);
    client.clear();
  });

  it("shows an error instead of cached statistics when a refresh fails", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path) => {
      if (path === "/api/workspaces/pinned") return { paths: [] };
      throw new Error("Service unavailable");
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["workspaces"], [{ name: "Cached", path: "/cached", project_id: "1", session_count: 3, last_modified: "2026-09-01T00:00:00Z" }]);
    renderPage(client);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryAllByText(i18n.t("projects.totalProjects")).filter(element => element.tagName === "P")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Open Cached" })).not.toBeInTheDocument();
    client.clear();
  });
});
