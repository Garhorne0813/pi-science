import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { useUiStore } from "@/lib/ui";
import { FilesPage } from "./FilesPage";

vi.mock("../../lib/workspace", () => ({
  useRequiredWorkspaceCwd: () => "proj",
}));

vi.mock("../../components/sidebar/FileBrowser", () => ({
  FileBrowser: ({ cwd, embedded, mode, fileType, conversationKey }: { cwd: string; embedded?: boolean; mode?: string; fileType?: string; conversationKey?: string | null }) => (
    <div data-testid="file-browser" data-cwd={cwd} data-embedded={String(embedded)} data-mode={mode} data-file-type={fileType} data-conversation-key={conversationKey ?? "new"} />
  ),
}));

vi.mock("../../components/layout/WorkspacePage", () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  WorkspacePageHeader: ({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) => (
    <header><h1>{title}</h1><p>{description}</p></header>
  ),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  useRuntimeStore.setState({ cwd: "proj", activeSessionId: null, sessions: [] });
  useUiStore.setState({ workspaceReferences: [] });
});

const renderPage = (entry = "/workspace/proj/files") => render(<MemoryRouter initialEntries={[entry]}><FilesPage /></MemoryRouter>);

describe("FilesPage", () => {
  it("renders the shared file tree in full page mode", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByText("Browse the workspace and preview a file without losing the tree.")).toBeInTheDocument();
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-cwd", "proj");
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-embedded", "true");
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-mode", "page");
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-file-type", "all");
    expect(screen.getByTestId("file-browser").parentElement).not.toHaveClass("rounded-card", "border", "bg-surface");
  });

  it("preserves the notebook-only route", () => {
    renderPage("/workspace/proj/files?type=notebook");
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-file-type", "notebook");
  });

  it("shows pending references with their explicit target conversation", () => {
    useRuntimeStore.setState({ sessions: [{ id: "session-a", cwd: "proj", name: "Analysis notes", created_at: "", updated_at: "" }] });
    useUiStore.setState({ workspaceReferences: [{ cwd: "proj", conversationKey: "session-a", path: "data/a.csv", name: "a.csv", isDir: false }] });
    renderPage("/workspace/proj/files?session_id=session-a");

    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-conversation-key", "session-a");
    expect(screen.getByText("1 referenced item")).toBeInTheDocument();
    expect(screen.getByText("For Analysis notes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Return to conversation/ })).toHaveAttribute("href", "/workspace/proj/session/session-a");
  });
});
