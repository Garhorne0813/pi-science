import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectsLayout } from "../../app/layout/ProjectsLayout";
import { WorkspaceProvider } from "../../lib/workspace";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { useUiStore } from "../../lib/ui";
import { FeedbackContext } from "../feedback/feedback-context";
import { useWorkspaceSidebar } from "./workspace-navigation";
import i18n from "../../i18n";

vi.mock("../../lib/memory", () => ({ useMemorySummary: () => ({ data: { pendingCount: 0 } }) }));

const feedback = { toast: vi.fn(), confirm: vi.fn(async () => true) };
let narrow = false;
let listeners = new Set<(event: MediaQueryListEvent) => void>();
function resize(width: number) { act(() => { vi.stubGlobal("innerWidth", width); narrow = width < 768; for (const listener of listeners) listener({ matches: narrow } as MediaQueryListEvent); }); }
function mount(initial = "/workspace/proj/research") {
  const router = createMemoryRouter([{ element: <WorkspaceProvider><ProjectsLayout /></WorkspaceProvider>, children: [
    { path: "/workspace/:cwd/research", element: <span>Main Research</span> },
    { path: "/workspace/:cwd/runs", element: <span>Main Runs</span> },
    { path: "/workspace/:cwd/files", element: <span>Main Files</span> },
  ] }], { initialEntries: [initial] });
  const view = render(<FeedbackContext.Provider value={feedback}><RouterProvider router={router} /></FeedbackContext.Provider>);
  return { ...view, router };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  narrow = false;
  listeners = new Set();
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("matchMedia", (query: string) => ({ get matches() { return query.includes("767") && narrow; }, media: query, addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { if (query.includes("767")) listeners.add(listener); }, removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener) }));
  useUiStore.setState({ contextPanelCollapsed: false, sidebarWidth: 299, inspectorOpen: false, inspectorTabs: [], settingsOpen: false });
  useWorkspaceSidebar.setState({ cwd: null, tab: "sessions", query: "" });
  useRuntimeStore.setState({ cwd: "proj", sessions: [{ id: "a", cwd: "proj", name: "Loaded A" }], activeSessionId: "a", sessionsHasMore: true, sessionsLoading: false, loadSessions: vi.fn(async () => []) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the conversation list and search across routes, collapse and breakpoint changes", async () => {
  const { container, router } = mount();
  const row = await screen.findByRole("button", { name: "Loaded A" });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Loaded" } });
  await act(async () => router.navigate("/workspace/proj/runs"));
  expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(container.querySelector("aside")).toHaveAttribute("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(screen.getByRole("button", { name: "Loaded A" })).toBe(row);
  expect(screen.getByRole("searchbox")).toHaveValue("Loaded");
  resize(767);
  expect(container.querySelector("aside")).toHaveAttribute("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  resize(768);
  expect(screen.getByRole("button", { name: "Loaded A" })).toBe(row);
});

it("replaces old conversations and clears search after switching projects", async () => {
  const { router } = mount();
  await screen.findByRole("button", { name: "Loaded A" });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Loaded" } });
  await act(async () => router.navigate("/workspace/other/research"));
  act(() => useRuntimeStore.setState({ cwd: "other", sessions: [{ id: "b", cwd: "other", name: "Loaded B" }], activeSessionId: null, sessionsHasMore: false }));
  expect(screen.queryByRole("button", { name: "Loaded A" })).toBeNull();
  expect(screen.getByRole("button", { name: "Loaded B" })).toBeInTheDocument();
  expect(screen.getByRole("searchbox")).toHaveValue("");
});

it("loads conversation context when opening a Runs deep link directly", async () => {
  const loadSessions = vi.fn(async (cwd = "proj") => {
    const sessions = [{ id: "a", cwd, name: "Loaded A" }];
    useRuntimeStore.setState({ cwd, sessions });
    return sessions;
  });
  useRuntimeStore.setState({ sessions: [], loadSessions });
  const { router } = mount("/workspace/proj/runs?session_id=a");
  expect(await screen.findByRole("button", { name: "Loaded A" })).toBeInTheDocument();
  expect(loadSessions).toHaveBeenCalledWith("proj");
  expect(router.state.location.search).toBe("?session_id=a");
});
