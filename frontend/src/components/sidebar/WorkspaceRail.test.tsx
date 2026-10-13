import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../i18n";
import { WorkspaceRail } from "./WorkspaceRail";
vi.mock("../../lib/knowledge", () => ({ usePendingProposalCount: () => ({ data: { pending_count: 0 } }) }));
vi.mock("./workspace-navigation", () => ({ closeSidebarOnNarrow: vi.fn(), useNewWorkspaceConversation: () => vi.fn(), useWorkspaceSidebar: { getState: () => ({ showConversations: vi.fn() }) } }));
beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);
it.each([
  ["/workspace/project/session/session-A", "/workspace/project/runs?session_id=session-A"],
  ["/workspace/project", "/workspace/project/runs"],
  ["/workspace/project/runs?session_id=session-A&scope=workspace", "/workspace/project/runs?session_id=session-A"],
])("links the runs entry from %s with the right context", (path, target) => {
  render(<MemoryRouter initialEntries={[path]}><WorkspaceRail cwd="project" /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("href", target);
});
