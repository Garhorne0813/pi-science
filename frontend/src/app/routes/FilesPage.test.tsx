import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import i18n from "@/i18n";
import type { FileListEntry } from "../../components/sidebar/FileContextMenu";
import { FilesPage } from "./FilesPage";

const entries = (names: string[]): FileListEntry[] => names.map((name) => ({
  name,
  path: name,
  isDir: false,
  size: 12,
  modified: 1,
}));

vi.mock("../../lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspace")>();
  return {
    ...actual,
    useRequiredWorkspaceCwd: () => "proj",
    workspaceFiles: {
      invalidate: vi.fn(),
      directory: vi.fn(async (_cwd: string, subdir: string) => ({
        entries: entries(subdir ? ["sub.txt"] : ["a.txt", "b.txt"]),
        breadcrumbs: subdir ? [{ name: subdir, path: subdir }] : [],
      })),
      refreshDirectory: vi.fn(async () => ({ entries: entries(["a.txt", "b.txt", "new.txt"]), breadcrumbs: [] })),
      remove: vi.fn(async () => undefined),
      formatSize: actual.workspaceFiles.formatSize,
    },
  };
});

vi.mock("../../components/feedback/feedback-context", () => {
  const toast = vi.fn();
  const confirm = vi.fn(async () => true);
  return { useFeedback: () => ({ toast, confirm }) };
});

vi.mock("../../components/layout/WorkspacePage", () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WorkspacePageHeader: ({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      <div>{title}</div>
      {description}
      {actions}
    </div>
  ),
  WorkspacePageRefreshButton: ({ label, onClick }: { label: string; onClick: () => void }) => <button onClick={onClick}>{label}</button>,
}));

const files = (await import("../../lib/workspace")).workspaceFiles as unknown as {
  directory: ReturnType<typeof vi.fn>;
  refreshDirectory: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  formatSize: (bytes: number) => string;
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  useRuntimeStore.setState({ fileRevision: 0, cwd: "proj", activeSessionId: null });
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("FilesPage", () => {
  it("loads the directory listing on mount", async () => {
    render(<FilesPage />);
    await screen.findByText("a.txt");
    expect(files.directory).toHaveBeenCalledWith("proj", "", expect.anything());
  });

  it("polls while the tab is visible and stays quiet (no loading flash)", async () => {
    render(<FilesPage />);
    await screen.findByText("a.txt");
    // The polling refresh surfaces a newly created file without touching
    // the loading state: the list simply updates in place (first poll fires
    // after 2s, so give the finder more than the default 1s budget).
    await screen.findByText("new.txt", {}, { timeout: 4_000 });
    expect(files.refreshDirectory).toHaveBeenCalled();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("does not poll while the tab is hidden", async () => {
    render(<FilesPage />);
    await screen.findByText("a.txt");
    files.refreshDirectory.mockClear();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(files.refreshDirectory).not.toHaveBeenCalled();
  });

  it("stops polling on unmount", async () => {
    const { unmount } = render(<FilesPage />);
    await screen.findByText("a.txt");
    files.refreshDirectory.mockClear();
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(files.refreshDirectory).not.toHaveBeenCalled();
  });

  it("keeps the manual refresh button working", async () => {
    render(<FilesPage />);
    await screen.findByText("a.txt");
    files.directory.mockClear();
    fireEvent.click(screen.getByText("Refresh"));
    await vi.waitFor(() => expect(files.directory).toHaveBeenCalled());
  });
});
