import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SettingsNavItem, SidebarNavItem, CollapsedNavItem, WorkspaceSessionList } from "./ProjectsLayout";
import { Clock3 } from "lucide-react";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import i18n from "../../i18n";
import type { SessionInfo } from "../../lib/client/types";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

function NavigationButton({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>{label}</button>;
}

function session(id: string, name: string): SessionInfo {
  return { id, cwd: "proj", name, updated_at: new Date().toISOString() };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  useUiStore.setState({ settingsOpen: false, settingsScope: null, suppressAutoSessionNav: false });
  useRuntimeStore.setState({
    sessions: [],
    activeSessionId: null,
    cwd: "proj",
    loadSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    createNewSession: vi.fn(async () => "created"),
    forkSession: vi.fn(async () => "forked"),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scheduled-tasks navigation", () => {
  it("renders the expanded entry and navigates to the scheduled-tasks route", () => {
    render(
      <MemoryRouter initialEntries={["/workspace/proj"]}>
        <Routes>
          <Route path="/workspace/:cwd" element={<><SidebarNavItem to="/workspace/proj/scheduled-tasks" label="Scheduled Tasks" icon={Clock3} active={false} /><LocationProbe /></>} />
          <Route path="/workspace/:cwd/scheduled-tasks" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Scheduled Tasks" }));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/scheduled-tasks");
  });

  it("renders the collapsed entry and marks it active on the scheduled-tasks route", () => {
    render(
      <MemoryRouter initialEntries={["/workspace/proj/scheduled-tasks"]}>
        <CollapsedNavItem to="/workspace/proj/scheduled-tasks" icon={Clock3} label="Scheduled Tasks" />
      </MemoryRouter>,
    );

    const item = screen.getByRole("button", { name: "Scheduled Tasks" });
    expect(item).toHaveClass("text-accent");
  });
});

describe("SettingsNavItem", () => {
  it("opens the dialog with the workspace scope without navigating", () => {
    render(
      <MemoryRouter initialEntries={["/workspace/proj"]}>
        <SettingsNavItem cwd="proj" />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsScope).toBe("proj");
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("h-nav");
  });

  it("opens the dialog with the global scope from the collapsed form", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <SettingsNavItem cwd={null} collapsed />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsScope).toBeNull();
  });
});

describe("WorkspaceSessionList", () => {
  // The real layout stays mounted across /workspace/:cwd ↔
  // /workspace/:cwd/session/:id navigation (the session list lives in the
  // layout, the route only swaps the Outlet content), so both routes render
  // the list next to a path probe — exactly like the production tree.
  function renderList(initialEntry = "/workspace/proj/session/s1") {
    return render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route
              path="/workspace/:cwd"
              element={<><WorkspaceSessionList cwd="proj" /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/session/:sessionId"
              element={<><WorkspaceSessionList cwd="proj" /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/files"
              element={<><WorkspaceSessionList cwd="proj" /><LocationProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );
  }

  function rowFor(name: string): HTMLElement {
    const button = screen.getByRole("button", { name: new RegExp(name) });
    const row = button.closest("div.group");
    if (!row) throw new Error(`session row for ${name} not found`);
    return row as HTMLElement;
  }

  function deleteButtonOf(name: string): HTMLButtonElement {
    const buttons = rowFor(name).querySelectorAll("button");
    const deleteButton = buttons[buttons.length - 1];
    if (!(deleteButton instanceof HTMLButtonElement)) throw new Error(`delete button for ${name} not found`);
    return deleteButton;
  }

  it("marks the active session with an accent dot and hides the placeholder dots", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A"), session("s2", "Session B")], activeSessionId: "s1" });
    renderList();

    const activeDot = rowFor("Session A").firstElementChild;
    expect(activeDot?.className).toContain("bg-accent");
    const inactiveDot = rowFor("Session B").firstElementChild;
    expect(inactiveDot?.className).not.toContain("bg-accent");
    expect((inactiveDot as HTMLElement).style.visibility).toBe("hidden");
  });

  it("does not load sessions for a workspace route other than the root", () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({ loadSessions });
    renderList("/workspace/proj/files");

    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("does not reload sessions when navigating from the root to a workspace page", async () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({ loadSessions });
    render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/workspace/proj"]}>
          <Routes>
            <Route
              path="/workspace/:cwd"
              element={<><WorkspaceSessionList cwd="proj" /><NavigationButton to="/workspace/proj/files" label="Go files" /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/files"
              element={<><WorkspaceSessionList cwd="proj" /><LocationProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Go files" }));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/files");
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });

  it("lands on the blank workspace after deleting the active session without creating a new one", async () => {
    const loadSessions = vi.fn(async () => [session("s2", "Session B")]);
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A"), session("s2", "Session B")],
      activeSessionId: "s1",
      loadSessions,
      deleteSession: vi.fn(async () => {
        useRuntimeStore.setState({ sessions: [session("s2", "Session B")], activeSessionId: null });
      }),
    });
    renderList();

    fireEvent.click(deleteButtonOf("Session A"));

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj"));
    const createNewSession = useRuntimeStore.getState().createNewSession as ReturnType<typeof vi.fn>;
    expect(createNewSession).not.toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();
    // Other sessions still exist, but the suppression keeps the landing blank
    // (no auto-nav pull-back into the most recent session).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
    expect(screen.getByRole("button", { name: /Session B/ })).toBeInTheDocument();
    expect(useUiStore.getState().suppressAutoSessionNav).toBe(false);
  });

  it("auto-opens the most recent session on a normal first entry to the workspace root", async () => {
    useRuntimeStore.setState({
      sessions: [],
      activeSessionId: null,
      loadSessions: vi.fn(async () => [session("s1", "Session A"), session("s2", "Session B")]),
    });
    render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/workspace/proj"]}>
          <Routes>
            <Route path="/workspace/:cwd" element={<><WorkspaceSessionList cwd="proj" /><LocationProbe /></>} />
            <Route path="/workspace/:cwd/session/:sessionId" element={<><WorkspaceSessionList cwd="proj" /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s1"));
  });

  it("keeps the blank landing after New Session instead of bouncing to the latest session", async () => {
    const loadSessions = vi.fn(async () => [session("s1", "Session A"), session("s2", "Session B")]);
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A"), session("s2", "Session B")],
      activeSessionId: null,
      loadSessions,
    });
    renderList();

    fireEvent.click(screen.getByTitle("New conversation"));

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj"));
    // Suppression is consumed by the effect; the landing must not be replaced
    // by the most recent session.
    expect(loadSessions).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
    expect(useUiStore.getState().suppressAutoSessionNav).toBe(false);
  });

  it("renders New Session as a labeled full-width bar with the target geometry", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();

    const button = screen.getByRole("button", { name: "New conversation" });
    expect(button).toHaveClass("h-new-session", "rounded-card");
    expect(button.textContent).toContain("New conversation");
  });

  it("reveals session actions when the row receives keyboard focus", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();

    const row = rowFor("Session A");
    expect(row.className).toContain("focus-within:bg-surface-hover");
    const deleteButton = deleteButtonOf("Session A");
    expect(deleteButton.className).toContain("group-focus-within:!inline-flex");
  });

  it("does not let a repeated New Session click at root suppress the next normal root entry", async () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A")],
      activeSessionId: null,
      loadSessions,
    });
    render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/workspace/proj"]}>
          <NavigationButton to="/" label="Go projects" />
          <NavigationButton to="/workspace/proj" label="Go workspace" />
          <Routes>
            <Route path="/" element={<LocationProbe />} />
            <Route path="/workspace/:cwd" element={<><WorkspaceSessionList cwd="proj" /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTitle("New conversation"));
    fireEvent.click(screen.getByTitle("New conversation"));
    expect(useUiStore.getState().suppressAutoSessionNav).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Go projects" }));
    expect(screen.getByTestId("path").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Go workspace" }));

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(2));
    expect(useUiStore.getState().suppressAutoSessionNav).toBe(false);
  });

  it("does not kick the user out of a session they opened while the delete was in flight", async () => {
    let releaseDelete!: () => void;
    const gate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A"), session("s2", "Session B")],
      activeSessionId: "s1",
      deleteSession: vi.fn(async () => {
        await gate;
        useRuntimeStore.setState({ sessions: [session("s2", "Session B")], activeSessionId: "s2" });
      }),
    });
    renderList();

    fireEvent.click(deleteButtonOf("Session A"));
    // The delete is in flight; the user switches to the other session.
    fireEvent.click(screen.getByRole("button", { name: /Session B/ }));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s2");

    await act(async () => {
      releaseDelete();
      await gate;
    });

    // Still on the session the user switched to — no landing, no new session.
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s2"));
    const createNewSession = useRuntimeStore.getState().createNewSession as ReturnType<typeof vi.fn>;
    expect(createNewSession).not.toHaveBeenCalled();
    expect(useUiStore.getState().suppressAutoSessionNav).toBe(false);
  });
});
