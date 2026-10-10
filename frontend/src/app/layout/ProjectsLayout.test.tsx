import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SidebarMainArea } from "../../components/sidebar/SidebarMainArea";
import userEvent from "@testing-library/user-event";
import { ProjectsLayout } from "./ProjectsLayout";
import { WorkspaceRail } from "../../components/sidebar/WorkspaceRail";
import { WorkspaceSessionList } from "../../components/sidebar/WorkspaceSessionList";
import { useWorkspaceSidebar } from "../../components/sidebar/workspace-navigation";
import { WorkspaceProvider } from "../../lib/workspace";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import i18n from "../../i18n";
import type { SessionInfo } from "../../lib/client/types";

const pendingKnowledge = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../lib/knowledge", () => ({ usePendingProposalCount: () => ({ data: { pending_count: pendingKnowledge.count } }) }));

vi.mock("../../components/sidebar/FileBrowser", () => ({ FileBrowser: () => <span>Embedded file tree</span> }));
vi.mock("../../components/inspector/InspectorTabs", () => ({ InspectorTabs: () => <button>Inspector control</button> }));

function SidebarFixture() {
  return <><WorkspaceRail cwd="proj" /><SidebarMainArea cwd="proj" renderSessions={query => <WorkspaceSessionList cwd="proj" query={query} />} /></>;
}

function LocationProbe() {
  const location = useLocation();
  return <><span data-testid="path">{location.pathname}</span><span data-testid="location-state">{JSON.stringify(location.state)}</span></>;
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
  pendingKnowledge.count = 0;
  useWorkspaceSidebar.setState({ cwd: null, tab: "sessions", query: "" });
  useUiStore.setState({ settingsOpen: false, settingsScope: null, contextPanelCollapsed: false, sidebarWidth: 240 });
  useRuntimeStore.setState({
    sessions: [],
    sessionsHasMore: false,
    sessionsLoading: false,
    loadMoreSessions: vi.fn(async () => 0),
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

function renderWorkspaceShell(initialEntry = "/workspace/proj/research") {
  return render(<FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}><MemoryRouter initialEntries={[initialEntry]}><Routes><Route path="/workspace/:cwd" element={<WorkspaceProvider><ProjectsLayout /></WorkspaceProvider>}><Route index element={<LocationProbe />} /><Route path="session/:sessionId" element={<LocationProbe />} /><Route path="research" element={<LocationProbe />} /><Route path="runs" element={<LocationProbe />} /><Route path="knowledge" element={<LocationProbe />} /><Route path="files" element={<LocationProbe />} /></Route></Routes></MemoryRouter></FeedbackContext.Provider>);
}

describe("V4 independent primary navigation and context", () => {
  it("Research and Files are simultaneously active without changing Main", async () => { const { container } = renderWorkspaceShell(); await userEvent.click(await screen.findByRole("tab", { name: "Files" })); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/research"); expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("aria-current", "page"); expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true"); expect(container.querySelector("aside")?.style.width).toBe("240px"); expect(container.querySelectorAll("nav[aria-label='Primary navigation']")).toHaveLength(1); });
  it("Runs and Conversations are simultaneously active without changing Main", async () => { renderWorkspaceShell("/workspace/proj/runs"); expect(await screen.findByRole("tab", { name: "Conversations" })).toHaveAttribute("aria-selected", "true"); expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("aria-current", "page"); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/runs"); });
  it("shows brand and project name in one Projects link in the panel", async () => {
    const { container } = renderWorkspaceShell();
    await screen.findByRole("searchbox");
    const header = container.querySelector("aside header")!;
    const link = header.querySelector("a")!;
    expect(link).toHaveAttribute("href", "/");
    expect(link).toHaveAttribute("title", "proj");
    expect(link.textContent).toBe("pi-scienceproj");
    expect(header.querySelectorAll("a")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Projects" })).toHaveTextContent("pi");
  });
  it("has one toggle and no duplicate primary links or panel New action", async () => { const { container } = renderWorkspaceShell(); await screen.findByRole("searchbox"); for (const name of ["Project Knowledge", "Research", "Run history"]) expect(screen.getAllByRole("link", { name })).toHaveLength(1); expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1); expect(screen.getAllByRole("button", { name: "New conversation" })).toHaveLength(1); expect(screen.getAllByRole("button", { name: "Workspace context panel" })).toHaveLength(1); expect(container.querySelector("aside")?.querySelectorAll("nav, button[title='New conversation']")).toHaveLength(0); });
  it("exposes the Knowledge pending count once in the Rail accessible name", async () => { pendingKnowledge.count = 2; const { container } = renderWorkspaceShell(); await screen.findByRole("searchbox"); const item = screen.getByRole("link", { name: "Project Knowledge (2 pending proposals)" }); expect(item).toHaveAttribute("href", "/workspace/proj/knowledge"); expect(item.querySelector("span[aria-hidden='true']")?.textContent).toBe("2"); expect(container.querySelector("aside")?.textContent).not.toContain("pending proposals"); expect(screen.getAllByRole("link", { name: "Project Knowledge (2 pending proposals)" })).toHaveLength(1); });
  it("full Files route claims no current Rail item and Settings only expands", async () => { const { container } = renderWorkspaceShell("/workspace/proj/files"); await screen.findByRole("searchbox"); expect(container.querySelectorAll("nav [aria-current]")).toHaveLength(0); const settings = screen.getByRole("button", { name: "Settings" }); expect(settings).toHaveAttribute("aria-expanded", "false"); expect(settings).not.toHaveAttribute("aria-current"); });
});

describe("mobile Context drawer", () => {
  function narrowViewport() { vi.stubGlobal("innerWidth", 375); vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: media.includes("767") || media.includes("1023"), addEventListener: vi.fn(), removeEventListener: vi.fn() })); }
  it("opens with focus and inerts Main, preview controls and the skip link then returns focus on Escape", async () => { narrowViewport(); const { container } = renderWorkspaceShell("/workspace/proj/session/s1"); const toggle = screen.getByRole("button", { name: "Workspace context panel" }); expect(toggle).toHaveAttribute("aria-expanded", "false"); fireEvent.click(toggle); const panel = container.querySelector("aside")!; expect(panel).toHaveFocus(); expect(toggle).toHaveAttribute("aria-expanded", "true"); expect(container.querySelector("main")).toHaveAttribute("inert"); expect(container.querySelector("a[href='#main-content']")).toHaveAttribute("inert"); expect(screen.queryByRole("link", { name: "Skip to content" })).toBe(null); const preview = screen.getByRole("button", { name: "Show preview panel", hidden: true }); expect(preview.closest("[inert]")).toHaveAttribute("aria-hidden", "true"); const shade = container.querySelector("[data-context-panel-shade]")!; expect(shade).toHaveAttribute("aria-hidden", "true"); expect(shade).not.toHaveAttribute("tabindex"); fireEvent.keyDown(panel, { key: "Escape" }); expect(panel).toHaveAttribute("hidden"); expect(toggle).toHaveFocus(); expect(container.querySelector("main")).not.toHaveAttribute("inert"); await screen.findByRole("link", { name: "Skip to content" }); });
  it("ignores an Escape that a modal dialog already handled", () => {
    narrowViewport();
    // Stands in for the shared confirmation dialog, which listens on window and
    // calls preventDefault. Registering first is what gives it priority.
    const dialogEscape = (event: KeyboardEvent) => { if (event.key === "Escape") event.preventDefault(); };
    window.addEventListener("keydown", dialogEscape);
    try {
      const { container } = renderWorkspaceShell();
      fireEvent.click(screen.getByRole("button", { name: "Workspace context panel" }));
      expect(container.querySelector("aside")).not.toHaveAttribute("hidden");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(container.querySelector("aside")).not.toHaveAttribute("hidden");
    } finally {
      window.removeEventListener("keydown", dialogEscape);
    }
  });

  it("closes on shade pointer down and returns focus to the one Rail toggle", () => { narrowViewport(); const { container } = renderWorkspaceShell(); const toggle = screen.getByRole("button", { name: "Workspace context panel" }); fireEvent.click(toggle); fireEvent.pointerDown(container.querySelector("[data-context-panel-shade]")!); expect(container.querySelector("aside")).toHaveAttribute("hidden"); expect(toggle).toHaveFocus(); expect(toggle).toHaveAttribute("aria-expanded", "false"); });
  it("keeps the Rail operable and closes the drawer when navigating to Runs", async () => { narrowViewport(); const { container } = renderWorkspaceShell(); fireEvent.click(screen.getByRole("button", { name: "Workspace context panel" })); await userEvent.click(screen.getByRole("link", { name: "Run history" })); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/runs"); expect(container.querySelector("aside")).toHaveAttribute("hidden"); expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("aria-current", "page"); });
  it("mobile New conversation clears Files and search, closes the drawer and creates no session", async () => { narrowViewport(); const { container } = renderWorkspaceShell("/workspace/proj/session/s1"); fireEvent.click(screen.getByRole("button", { name: "Workspace context panel" })); fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "old" } }); await userEvent.click(screen.getByRole("tab", { name: "Files" })); fireEvent.click(screen.getByRole("button", { name: "New conversation" })); expect(container.querySelector("aside")).toHaveAttribute("hidden"); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj"); expect(screen.getByRole("tab", { name: "Conversations", hidden: true })).toHaveAttribute("aria-selected", "true"); expect(screen.getByRole("searchbox", { hidden: true })).toHaveValue(""); expect(useRuntimeStore.getState().createNewSession).toHaveBeenCalledTimes(0); });
  it("removes a background inspector control from reach while the drawer is open", async () => { narrowViewport(); renderWorkspaceShell(); act(() => useUiStore.getState().openInspector({ variant: "file", path: "notes.txt", filename: "notes.txt", cwd: "proj" })); const control = await screen.findByRole("button", { name: "Inspector control" }); const chrome = screen.getByRole("dialog", { name: "Open file previews" }); expect(control.closest("[inert]")).toBe(null); fireEvent.click(screen.getByRole("button", { name: "Workspace context panel" })); expect(chrome).toHaveAttribute("inert"); expect(chrome).toHaveAttribute("aria-hidden", "true"); expect(control.closest("[inert]")).toBe(chrome); expect(screen.queryByRole("dialog", { name: "Open file previews" })).toBe(null); expect(screen.queryByRole("button", { name: "Inspector control" })).toBe(null); fireEvent.keyDown(document, { key: "Escape" }); expect(screen.getByRole("button", { name: "Inspector control" })).toBe(control); expect(screen.getByRole("button", { name: "Workspace context panel" })).toHaveFocus(); });
});

describe("WorkspaceRail Settings", () => {
  it("opens the dialog with the workspace scope without navigating", () => {
    render(
      <MemoryRouter initialEntries={["/workspace/proj"]}>
        <WorkspaceRail cwd="proj" />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Settings" })).not.toHaveAttribute("aria-current");
    expect(useUiStore.getState().settingsScope).toBe("proj");
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("h-header");
  });

  it("opens the dialog with the global scope from the collapsed form", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <WorkspaceRail cwd={null} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsScope).toBeNull();
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Projects" })).toHaveClass("text-text");
    expect(screen.queryByRole("button", { name: "Workspace context panel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Research" })).toBeNull();
  });
});

describe("collapsed workspace navigation", () => {
  function renderLayout() {
    useUiStore.setState({ contextPanelCollapsed: false, inspectorOpen: false, inspectorTabs: [] });
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    return render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/workspace/proj/session/s1"]}>
          <Routes>
            <Route path="/workspace/:cwd" element={<WorkspaceProvider><ProjectsLayout /></WorkspaceProvider>}>
              <Route index element={<LocationProbe />} />
              <Route path="session/:sessionId" element={<LocationProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );
  }

  for (const action of ["New conversation", "Conversations"]) {
    it(`selects Conversations and clears search after Files → collapse → ${action} → expand`, async () => {
      renderLayout();
      const search = await screen.findByRole("searchbox");
      fireEvent.change(search, { target: { value: "Session" } });
      await userEvent.click(screen.getByRole("tab", { name: "Files" }));
      fireEvent.click(screen.getByRole("button", { name: "Workspace context panel" }));
      fireEvent.click(screen.getByRole(action === "Conversations" ? "link" : "button", { name: action }));
      fireEvent.click(screen.getByRole("button", { name: "Workspace context panel" }));
      expect(screen.getByRole("tab", { name: "Conversations" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("searchbox")).toHaveValue("");
      expect(screen.getByTestId("path")).toHaveTextContent("/workspace/proj");
      expect(useRuntimeStore.getState().createNewSession).not.toHaveBeenCalled();
      if (action === "New conversation") expect(useRuntimeStore.getState().loadSessions).not.toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
    });
  }
});

describe("WorkspaceSessionList", () => {
  // The real layout stays mounted across /workspace/:cwd ↔
  // /workspace/:cwd/session/:id navigation (the session list lives in the
  // layout, the route only swaps the Outlet content), so both routes render
  // the list next to a path probe — exactly like the production tree.
  function renderList(initialEntry = "/workspace/proj/session/s1", confirm = async () => true) {
    return render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm }}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route
              path="/workspace/:cwd"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/session/:sessionId"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/files"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );
  }

  function rowFor(name: string): HTMLElement {
    const button = screen.getByRole("button", { name });
    const row = button.closest("div.group");
    if (!row) throw new Error(`session row for ${name} not found`);
    return row as HTMLElement;
  }

  async function deleteConversation(name: string) {
    await userEvent.click(screen.getByRole("button", { name: `Manage conversation: ${name}` }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete conversation" }));
  }

  it("marks the active session with an accent dot and hides the placeholder dots", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A"), session("s2", "Session B")], activeSessionId: "s1" });
    renderList();

    const activeDot = rowFor("Session A").querySelector("span[aria-hidden]");
    expect(activeDot?.className).toContain("bg-accent");
    const inactiveDot = rowFor("Session B").querySelector("span[aria-hidden]");
    expect(inactiveDot?.className).not.toContain("bg-accent");
    expect(inactiveDot?.className).toContain("bg-transparent");
    expect(rowFor("Session A")).toHaveClass("bg-surface-selected");
    expect(screen.getByRole("button", { name: "Session A" })).toHaveAttribute("aria-current", "page");
  });

  it("runtime connected session on Research has a dot but no URL-current selection", async () => { useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" }); renderWorkspaceShell(); const button = await screen.findByRole("button", { name: "Session A" }); expect(button).not.toHaveAttribute("aria-current"); expect(button).not.toHaveClass("font-medium"); expect(rowFor("Session A")).not.toHaveClass("bg-surface-selected"); expect(rowFor("Session A").querySelector("span[aria-hidden]")).toHaveClass("bg-accent"); expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("aria-current", "page"); });

  it("URL-current session selects independently from the runtime connection", () => { useRuntimeStore.setState({ sessions: [session("s1", "Session A"), session("s2", "Session B")], activeSessionId: "s2" }); renderList(); expect(screen.getByRole("button", { name: "Session A" })).toHaveAttribute("aria-current", "page"); expect(rowFor("Session A")).toHaveClass("bg-surface-selected"); expect(rowFor("Session A").querySelector("span[aria-hidden]")).toHaveClass("bg-transparent"); expect(screen.getByRole("button", { name: "Session B" })).not.toHaveAttribute("aria-current"); expect(rowFor("Session B")).not.toHaveClass("bg-surface-selected"); expect(rowFor("Session B").querySelector("span[aria-hidden]")).toHaveClass("bg-accent"); });

  it("confirms deletion with FeedbackProvider and leaves sessions intact on cancel", async () => { const confirm = vi.fn(async () => false); useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" }); renderList("/workspace/proj/session/s1", confirm); await deleteConversation("Session A"); expect(confirm).toHaveBeenCalledWith({ title: "Delete conversation", message: "“Session A” will be permanently deleted. This cannot be undone.", confirmLabel: "Delete", destructive: true }); expect(useRuntimeStore.getState().deleteSession).toHaveBeenCalledTimes(0); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s1"); expect(screen.getByRole("button", { name: "Session A" })).toBeInTheDocument(); });

  it("abandons a confirmed delete when the workspace switched while the dialog was open", async () => {
    let approve: (value: boolean) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList("/workspace/proj/session/s1", confirm);
    await deleteConversation("Session A");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().deleteSession).toHaveBeenCalledTimes(0);
    // The confirmation dialog lives outside the router, so it survives the switch.
    useRuntimeStore.setState({ cwd: "other", sessions: [session("b1", "Session B")], activeSessionId: null });
    await act(async () => { approve(true); });
    expect(useRuntimeStore.getState().deleteSession).toHaveBeenCalledTimes(0);
  });

  it("renders every loaded page and offers loading for older conversations", () => {
    const loadMoreSessions = vi.fn(async () => 0);
    useRuntimeStore.setState({
      sessions: Array.from({ length: 35 }, (_, index) => session(`s${index}`, `Session ${index}`)),
      sessionsHasMore: true,
      sessionsLoading: false,
      loadMoreSessions,
    });
    renderList();

    expect(screen.getByRole("button", { name: "Session 34" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older conversations" }));
    expect(loadMoreSessions).toHaveBeenCalledTimes(1);
  });

  it("does not load sessions for a workspace route other than the root", () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({ loadSessions });
    renderList("/workspace/proj/files");

    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("loads sessions for a direct conversation route when the list is empty", async () => {
    const loadSessions = vi.fn(async () => [session("s1", "Session A")]);
    useRuntimeStore.setState({ sessions: [], activeSessionId: "s1", loadSessions });
    renderList("/workspace/proj/session/s1");

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s1");
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
              element={<><SidebarFixture /><NavigationButton to="/workspace/proj/files" label="Go files" /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/files"
              element={<><SidebarFixture /><LocationProbe /></>}
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

    await deleteConversation("Session A");

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj"));
    expect(screen.getByTestId("location-state").textContent).toBe('{"landingIntent":{"kind":"active-session-deleted","cwd":"proj"}}');
    const createNewSession = useRuntimeStore.getState().createNewSession as ReturnType<typeof vi.fn>;
    expect(createNewSession).not.toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();
    // Other sessions still exist, but the suppression keeps the landing blank
    // (no auto-nav pull-back into the most recent session).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
    expect(screen.getByRole("button", { name: "Session B" })).toBeInTheDocument();
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
            <Route path="/workspace/:cwd" element={<><SidebarFixture /><LocationProbe /></>} />
            <Route path="/workspace/:cwd/session/:sessionId" element={<><SidebarFixture /><LocationProbe /></>} />
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
  });

  it("renders New conversation only once in the Rail with secondary styling", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();

    const button = screen.getByRole("button", { name: "New conversation" });
    expect(button).toHaveClass("h-header", "w-header", "bg-accent-soft", "border-accent-border");
    expect(button).not.toHaveClass("bg-accent-fill");
    expect(screen.getAllByRole("button", { name: "New conversation" })).toHaveLength(1);
    expect(button.closest("nav")).toHaveAttribute("aria-label", "Primary navigation");
  });

  it("reveals session actions when the row receives keyboard focus", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();

    const row = rowFor("Session A");
    expect(row.className).toContain("focus-within:bg-surface-hover");
    const menuButton = screen.getByRole("button", { name: "Manage conversation: Session A" });
    expect(menuButton.className).toContain("group-focus-within:opacity-100");
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
            <Route path="/workspace/:cwd" element={<><SidebarFixture /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTitle("New conversation"));
    fireEvent.click(screen.getByTitle("New conversation"));

    fireEvent.click(screen.getByRole("button", { name: "Go projects" }));
    expect(screen.getByTestId("path").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Go workspace" }));

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(2));
  });

  it("uses concise search copy without weakening the loaded-only accessible label", () => {
    renderList();
    const search = screen.getByRole("searchbox", { name: "Search loaded conversations" });
    expect(search).toHaveAttribute("placeholder", "Search conversations…");
    expect(search).toHaveAttribute("aria-describedby");
    expect(search.closest("label")).toHaveClass("bg-surface-2");
  });

  it("keeps sessions mounted while switching tabs and applies search to loaded pages", async () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({ sessions: [session("s1", "Protein study"), session("s2", "Genome study")], activeSessionId: "s1", sessionsHasMore: true, loadSessions });
    renderList();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Protein" } });
    expect(screen.queryByRole("button", { name: "Genome study" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Search covers loaded conversations only;/)).toHaveLength(2);
    const row = screen.getByRole("button", { name: "Protein study" });
    await userEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(row).toBeInTheDocument();
    expect(row.closest('[role="tabpanel"]')).toHaveAttribute("hidden");
    expect(await screen.findByText("Embedded file tree")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Conversations" }));
    expect(screen.getByRole("button", { name: "Protein study" })).toBe(row);
    expect(loadSessions).not.toHaveBeenCalled();
    act(() => useRuntimeStore.setState({ sessions: [...useRuntimeStore.getState().sessions, session("s3", "Protein follow-up")] }));
    expect(screen.getByRole("button", { name: "Protein follow-up" })).toBeInTheDocument();
  });

  it("navigates from the file tab and closes the narrow drawer", async () => {
    vi.stubGlobal("innerWidth", 375);
    useUiStore.setState({ contextPanelCollapsed: false });
    renderList();
    await userEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: /View all files/ }));
    expect(screen.getByTestId("path")).toHaveTextContent("/workspace/proj/files");
    expect(useUiStore.getState().contextPanelCollapsed).toBe(true);
  });

  it("supports keyboard menu navigation, Escape focus return, and fork", async () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();
    const trigger = screen.getByRole("button", { name: "Manage conversation: Session A" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Fork conversation" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete conversation" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}{Enter}");
    await waitFor(() => expect(useRuntimeStore.getState().forkSession).toHaveBeenCalledWith("s1"));
    // Calling the async fork action precedes its resolved result and navigation.
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/workspace/proj/session/forked"));
  });

  it("does not replace Research after an in-flight connected-session delete", async () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); useRuntimeStore.setState({ sessions: [session("s1", "Session A"), session("s2", "Session B")], activeSessionId: "s1", deleteSession: vi.fn(async () => { await gate; useRuntimeStore.setState({ sessions: [session("s2", "Session B")], activeSessionId: null }); }) }); renderWorkspaceShell("/workspace/proj/session/s1"); await screen.findByRole("button", { name: "Session A" }); await deleteConversation("Session A"); await userEvent.click(screen.getByRole("link", { name: "Research" })); await act(async () => { release(); await gate; }); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/research"); expect(screen.getByTestId("location-state").textContent).toBe("null"); });

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

    await deleteConversation("Session A");
    // The delete is in flight; the user switches to the other session.
    fireEvent.click(screen.getByRole("button", { name: "Session B" }));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s2");

    await act(async () => {
      releaseDelete();
      await gate;
    });

    // Still on the session the user switched to — no landing, no new session.
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s2"));
    const createNewSession = useRuntimeStore.getState().createNewSession as ReturnType<typeof vi.fn>;
    expect(createNewSession).not.toHaveBeenCalled();
  });
});
