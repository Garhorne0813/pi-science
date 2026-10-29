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
      mkdir: vi.fn(async () => undefined),
      createFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
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
  mkdir: ReturnType<typeof vi.fn>;
  createFile: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
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

  it("drops a stale poll result that raced a directory switch", async () => {
    const dirEntry: FileListEntry = { name: "work", path: "work", isDir: true, size: 0, modified: 1 };
    files.directory.mockImplementation(async (_cwd: string, subdir: string) => ({
      entries: subdir ? entries(["inner.txt"]) : [dirEntry],
      breadcrumbs: subdir ? [{ name: "work", path: "work" }] : [],
    }));
    let resolveSlow!: (value: { entries: FileListEntry[]; breadcrumbs: never[] }) => void;
    files.refreshDirectory.mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }));

    render(<FilesPage />);
    await screen.findByText("work");
    // First poll fires after 2s and stays pending (slow refresh for the root).
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(resolveSlow).toBeDefined();
    // Navigate into work/ while the root poll is still in flight.
    fireEvent.click(screen.getByText("work"));
    await screen.findByText("inner.txt");
    // The stale root result resolves late: it must NOT overwrite inner.txt.
    resolveSlow({ entries: entries(["a.txt", "b.txt", "new.txt"]), breadcrumbs: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("inner.txt")).toBeInTheDocument();
    expect(screen.queryByText("a.txt")).toBeNull();
  });
});

describe("FilesPage inline file edits", () => {
  it("offers New file and New folder as the first two items on a file row", async () => {
    render(<FilesPage />);
    await screen.findByText("a.txt");
    fireEvent.contextMenu(screen.getByText("a.txt"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.slice(0, 2).map((item) => item.textContent)).toEqual(["New file", "New folder"]);
  });

  it("creates a file in the current directory from a file row", async () => {
    render(<FilesPage />);
    await screen.findByText("a.txt");
    fireEvent.contextMenu(screen.getByText("a.txt"));
    fireEvent.click(screen.getByText("New file"));
    const input = await screen.findByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "notes.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(files.createFile).toHaveBeenCalledWith("proj", "notes.txt"));
  });

  it("creates a folder inside the folder row it was opened from", async () => {
    const dirEntry: FileListEntry = { name: "work", path: "work", isDir: true, size: 0, modified: 1 };
    files.directory.mockImplementation(async (_cwd: string, subdir: string) => ({
      entries: subdir ? [] : [dirEntry],
      breadcrumbs: subdir ? [{ name: "work", path: "work" }] : [],
    }));
    render(<FilesPage />);
    await screen.findByText("work");
    fireEvent.contextMenu(screen.getByText("work"));
    fireEvent.click(screen.getByText("New folder"));
    // The listing navigates into work/ and is empty, yet the input still renders.
    const input = await screen.findByRole("textbox", { name: "Folder name" });
    expect(screen.queryByText("No files")).toBeNull();
    fireEvent.change(input, { target: { value: "sub" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(files.mkdir).toHaveBeenCalledWith("proj", "work/sub", { exclusive: true }));
    expect(files.directory).toHaveBeenCalledWith("proj", "work", expect.anything());
  });

  it("creates in the current directory from the header button while the listing is empty", async () => {
    files.directory.mockImplementation(async () => ({ entries: [], breadcrumbs: [] }));
    render(<FilesPage />);
    await screen.findByText("No files");
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const input = await screen.findByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "blank.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(files.createFile).toHaveBeenCalledWith("proj", "blank.md"));
  });

  it("replaces the renamed row and renames to a sibling path", async () => {
    render(<FilesPage />);
    await screen.findByText("a.txt");
    fireEvent.contextMenu(screen.getByText("a.txt"));
    fireEvent.click(screen.getByText("Rename"));
    const input = await screen.findByRole("textbox", { name: "Rename" });
    expect(input).toHaveValue("a.txt");
    expect(screen.queryByText("a.txt")).toBeNull();
    fireEvent.change(input, { target: { value: "c.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(files.rename).toHaveBeenCalledWith("proj", "a.txt", "c.txt"));
  });

  it("keeps the draft open with the inline conflict message on a 409", async () => {
    files.createFile.mockRejectedValueOnce(Object.assign(new Error("exists"), { status: 409 }));
    render(<FilesPage />);
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const input = await screen.findByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "dup.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("A file or folder with that name already exists");
    expect(screen.getByRole("textbox", { name: "File name" })).toHaveValue("dup.txt");
  });
});
