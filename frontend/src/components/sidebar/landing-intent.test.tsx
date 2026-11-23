import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { FeedbackContext } from "../feedback/feedback-context";
import { WorkspaceSessionList } from "./WorkspaceSessionList";
import { useNewWorkspaceConversation, useWorkspaceSidebar } from "./workspace-navigation";
import i18n from "../../i18n";

const sessions = [{ id: "s1", cwd: "proj", name: "First" }];
function Shell() { const newConversation = useNewWorkspaceConversation("proj"); return <><button onClick={() => newConversation()}>New</button><WorkspaceSessionList cwd="proj" /><Outlet /></>; }
function mount(entry: string, strict = false) {
  const router = createMemoryRouter([{ element: <Shell />, children: [
    { path: "/workspace/proj", element: <span>Root</span> },
    { path: "/workspace/proj/new", element: <span>Blank</span> },
    { path: "/workspace/proj/session/:sessionId", element: <span>Session</span> },
  ] }], { initialEntries: [entry] });
  const app = <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}><RouterProvider router={router} /></FeedbackContext.Provider>;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  return router;
}
beforeEach(async () => { await i18n.changeLanguage("en"); useWorkspaceSidebar.setState({ cwd: "proj", tab: "files", query: "old" }); useRuntimeStore.setState({ cwd: "proj", sessions, sessionsHasMore: false, sessionsLoading: false, activeSessionId: null, loadSessions: vi.fn(async () => sessions), createNewSession: vi.fn(async () => "created") }); });
afterEach(() => cleanup());

it("uses a durable new-conversation URL without creating a session or clearing search", async () => {
  const router = mount("/workspace/proj");
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  await act(async () => {});
  expect(router.state.location.pathname).toBe("/workspace/proj/new");
  expect(useWorkspaceSidebar.getState()).toMatchObject({ tab: "sessions", query: "old" });
  expect(useRuntimeStore.getState().createNewSession).not.toHaveBeenCalled();
});

it("keeps the blank page across repeated clicks, language changes, and StrictMode remounts", async () => {
  const router = mount("/workspace/proj/new", true);
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  await act(async () => { await i18n.changeLanguage("zh-Hans"); });
  expect(router.state.location.pathname).toBe("/workspace/proj/new");
  expect(useRuntimeStore.getState().createNewSession).not.toHaveBeenCalled();
});

it("auto-opens the most recent conversation on a normal project entry", async () => {
  const router = mount("/workspace/proj");
  await waitFor(() => expect(router.state.location.pathname).toBe("/workspace/proj/session/s1"));
  expect(useRuntimeStore.getState().loadSessions).toHaveBeenCalledTimes(1);
});
