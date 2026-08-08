import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { useUiStore } from "@/lib/ui";
import i18n from "@/i18n";
import type { FileListEntry } from "./FileContextMenu";
import { FileBrowser } from "./FileBrowser";

const sidebarEntries = (names: string[]): FileListEntry[] => names.map((name) => ({
  name,
  path: name,
  isDir: true,
  size: 0,
  modified: 1,
}));

vi.mock("../../lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspace")>();
  return {
    ...actual,
    workspaceFiles: {
      invalidate: vi.fn(),
      sidebar: vi.fn(async () => sidebarEntries(["work", "reports"])),
      directory: vi.fn(async (_cwd: string, subdir: string) => ({
        entries: subdir === "work" ? sidebarEntries(["data.csv"]) : sidebarEntries(["plot.png"]),
        breadcrumbs: [{ name: subdir, path: subdir }],
      })),
      refreshDirectory: vi.fn(),
      remove: vi.fn(async () => undefined),
      formatSize: actual.workspaceFiles.formatSize,
    },
  };
});

vi.mock("../../components/feedback/feedback-context", () => {
  // Stable refs: a fresh toast/confirm per render would change the identity
  // of FileBrowser's loadFiles callback and loop the refresh effect.
  const toast = vi.fn();
  const confirm = vi.fn(async () => true);
  return { useFeedback: () => ({ toast, confirm }) };
});

let files: ReturnType<typeof vi.mocked> & { sidebar: ReturnType<typeof vi.fn>; directory: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  await i18n.changeLanguage("en");
  const { workspaceFiles } = await import("../../lib/workspace");
  files = workspaceFiles as never;
});

beforeEach(() => {
  useRuntimeStore.setState({ fileRevision: 0, cwd: "proj", activeSessionId: "s1" });
  useUiStore.setState({ inspectorOpen: false, inspectorData: null });
  vi.clearAllMocks();
  // jsdom reports the tab as visible by default.
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("FileBrowser", () => {
  it("loads the root and auto-opens work/ on first load", async () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByText("Files"));
    await screen.findByText("data.csv");
    expect(files.sidebar.mock.calls.some((call) => call[0] === "proj")).toBe(true);
    expect(files.directory.mock.calls.some((call) => call[0] === "proj" && call[1] === "work")).toBe(true);
  });

  it("re-reads every expanded folder when the file revision bumps", async () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByText("Files"));
    await screen.findByText("data.csv");
    vi.mocked(files.directory).mockClear();
    act(() => { useRuntimeStore.setState({ fileRevision: 1 }); });
    await vi.waitFor(() => expect(files.directory).toHaveBeenCalledWith("proj", "work", expect.anything()));
  });

  it("refreshes an arbitrary expanded folder on revision bump (not just work/)", async () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByText("Files"));
    await screen.findByText("data.csv");
    // Expand a second folder.
    fireEvent.click(screen.getByText("reports"));
    await screen.findByText("plot.png");
    vi.mocked(files.directory).mockClear();
    act(() => { useRuntimeStore.setState({ fileRevision: 2 }); });
    await vi.waitFor(() => expect(files.directory).toHaveBeenCalledWith("proj", "reports", expect.anything()));
  });

  it("shows files created while a folder was closed after reopening it", async () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByText("Files"));
    await screen.findByText("data.csv");
    // Close work/, then a new file appears on the server.
    fireEvent.click(screen.getByText("work"));
    await vi.waitFor(() => expect(screen.queryByText("data.csv")).toBeNull());
    vi.mocked(files.directory).mockImplementation(async (_cwd: string, subdir: string) => ({
      entries: subdir === "work" ? sidebarEntries(["data.csv", "new.csv"]) : sidebarEntries(["plot.png"]),
      breadcrumbs: [{ name: subdir, path: subdir }],
    }));
    // Reopen: the listing must be re-read, not reused from a stale cache.
    fireEvent.click(screen.getByText("work"));
    await screen.findByText("new.csv");
  });

  it("polls while expanded and the tab is visible, and stops when hidden", async () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByText("Files"));
    await screen.findByText("data.csv");
    vi.mocked(files.sidebar).mockClear();
    // Visible tab: the 2s polling fallback fires on its own.
    await vi.waitFor(() => expect(files.sidebar).toHaveBeenCalled(), { timeout: 3_000 });
    const callsBefore = files.sidebar.mock.calls.length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(files.sidebar.mock.calls.length).toBe(callsBefore);
  });

  it("does not poll when collapsed", async () => {
    render(<FileBrowser cwd="proj" />);
    await act(async () => {});
    const callsBefore = files.sidebar.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(files.sidebar.mock.calls.length).toBe(callsBefore);
  });
});
