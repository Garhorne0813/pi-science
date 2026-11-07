import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { useUiStore } from "@/lib/ui";
import i18n from "@/i18n";
import { ApiError, apiRequest } from "../../lib/client/api";
import { useFeedback } from "../feedback/feedback-context";
import type { FileListEntry } from "./FileContextMenu";
import { FileBrowser } from "./FileBrowser";
import { SidebarMainArea } from "./SidebarMainArea";
import { useWorkspaceSidebar } from "./workspace-navigation";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../lib/client/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/client/api")>(),
  apiRequest: vi.fn(),
}));

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
      mkdir: vi.fn(async () => undefined),
      createFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
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

let files: ReturnType<typeof vi.mocked> & { sidebar: ReturnType<typeof vi.fn>; directory: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn>; mkdir: ReturnType<typeof vi.fn>; createFile: ReturnType<typeof vi.fn>; rename: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  await i18n.changeLanguage("en");
  const { workspaceFiles } = await import("../../lib/workspace");
  files = workspaceFiles as never;
});

beforeEach(() => {
  useRuntimeStore.setState({ fileRevision: 0, cwd: "proj", activeSessionId: "s1" });
  useUiStore.setState({ inspectorOpen: false, inspectorData: null, sidebarFileBrowserHeight: 288 });
  vi.clearAllMocks();
  // jsdom reports the tab as visible by default.
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FileBrowser", () => {
  it("sorts siblings naturally at each depth without moving files out of their parent", async () => {
    const entry = (path: string, isDir: boolean): FileListEntry => ({
      path, name: path.split("/").at(-1)!, isDir, size: 0, modified: 1,
    });
    files.sidebar.mockResolvedValueOnce([
      entry("file10.csv", false), entry("dir10", true), entry("file2.csv", false), entry("dir2", true),
    ]);
    files.directory.mockResolvedValueOnce({
      entries: [
        entry("dir2/plot10.png", false), entry("dir2/sub10", true),
        entry("dir2/plot2.png", false), entry("dir2/sub2", true),
      ],
      breadcrumbs: [{ name: "dir2", path: "dir2" }],
    });
    render(<FileBrowser cwd="proj" embedded />);
    await screen.findByRole("button", { name: "dir2" });
    const names = () => screen.getAllByRole("button").map(button => button.textContent?.trim()).filter(Boolean);
    expect(names()).toEqual(["dir2", "dir10", "file2.csv", "file10.csv"]);
    fireEvent.click(screen.getByRole("button", { name: "dir2" }));
    await screen.findByRole("button", { name: "sub2" });
    expect(names()).toEqual([
      "dir2", "sub2", "sub10", "plot2.png", "plot10.png",
      "dir10", "file2.csv", "file10.csv",
    ]);
    expect(screen.getByRole("button", { name: "dir2" })).toHaveAttribute("aria-expanded", "true");
  });

  it("pauses embedded requests while inactive and refreshes immediately when shown again", async () => {
    const view = render(<FileBrowser cwd="proj" embedded active={false} />);
    await act(async () => {});
    expect(files.sidebar).not.toHaveBeenCalled();
    vi.useFakeTimers();
    view.rerender(<FileBrowser cwd="proj" embedded active />);
    await act(async () => {});
    expect(files.sidebar).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(files.sidebar).toHaveBeenCalledTimes(2);
    view.rerender(<FileBrowser cwd="proj" embedded active={false} />);
    act(() => useRuntimeStore.setState({ fileRevision: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(files.sidebar).toHaveBeenCalledTimes(2);
    view.rerender(<FileBrowser cwd="proj" embedded active />);
    await act(async () => {});
    expect(files.sidebar).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(files.sidebar).toHaveBeenCalledTimes(4);
  });

  it("fills the embedded panel without resize or collapse controls and preserves refresh", async () => {
    render(<FileBrowser cwd="proj" embedded />);
    await screen.findByText("data.csv");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
    const before = files.sidebar.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
    await vi.waitFor(() => expect(files.sidebar.mock.calls.length).toBeGreaterThan(before));
    expect(files.invalidate).toHaveBeenCalledTimes(1);
  });

  it("loads the root and auto-opens work/ on first load", async () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByText("Files"));
    await screen.findByText("data.csv");
    expect(files.sidebar.mock.calls.some((call) => call[0] === "proj")).toBe(true);
    expect(files.directory.mock.calls.some((call) => call[0] === "proj" && call[1] === "work")).toBe(true);
  });

  it("exposes the expand toggle and refresh as real buttons", async () => {
    render(<FileBrowser cwd="proj" />);
    const expand = screen.getByRole("button", { name: "Files" });
    fireEvent.click(expand);
    await screen.findByText("data.csv");

    const refresh = screen.getByRole("button", { name: "Refresh files" });
    const callsBefore = files.sidebar.mock.calls.length;
    fireEvent.click(refresh);
    expect(files.invalidate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(files.sidebar.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("lets keyboard users resize the expanded file browser", async () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));

    const resize = screen.getByRole("separator", { name: "Resize file browser" });
    expect(resize).toHaveAttribute("aria-valuenow", "288");
    fireEvent.keyDown(resize, { key: "ArrowUp" });

    expect(resize).toHaveAttribute("aria-valuenow", "304");
    expect(useUiStore.getState().sidebarFileBrowserHeight).toBe(304);
  });

  it("resizes the expanded file browser by dragging its top edge", () => {
    render(<FileBrowser cwd="proj" />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));

    const resize = screen.getByRole("separator", { name: "Resize file browser" });
    fireEvent.pointerDown(resize, { button: 0, pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 200 });
    expect(resize).toHaveAttribute("aria-valuenow", "388");
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 200 });

    expect(useUiStore.getState().sidebarFileBrowserHeight).toBe(388);
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

  it("panel visibility stops polling and restores an immediate read before the next tick", async () => {
    useWorkspaceSidebar.setState({ cwd: "proj", tab: "files", query: "" });
    useUiStore.setState({ contextPanelCollapsed: false });
    render(<MemoryRouter><SidebarMainArea cwd="proj" renderSessions={() => null} /></MemoryRouter>);
    await screen.findByText("data.csv");
    expect(files.sidebar).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    act(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(files.sidebar).toHaveBeenCalledTimes(1);
    await act(async () => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(files.sidebar).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(files.sidebar).toHaveBeenCalledTimes(3);
    act(() => useUiStore.getState().setContextPanelCollapsed(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(files.sidebar).toHaveBeenCalledTimes(3);
    await act(async () => useUiStore.getState().setContextPanelCollapsed(false));
    expect(files.sidebar).toHaveBeenCalledTimes(4);
    act(() => useWorkspaceSidebar.getState().setTab("proj", "sessions"));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(files.sidebar).toHaveBeenCalledTimes(4);
    await act(async () => useWorkspaceSidebar.getState().setTab("proj", "files"));
    expect(files.sidebar).toHaveBeenCalledTimes(5);
  });

  it("does not poll when collapsed", async () => {
    render(<FileBrowser cwd="proj" />);
    await act(async () => {});
    const callsBefore = files.sidebar.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(files.sidebar.mock.calls.length).toBe(callsBefore);
  });

  it("stops the loading indicator when a quiet poll supersedes a visible load", async () => {
    render(<FileBrowser cwd="proj" embedded />);
    const refresh = screen.getByRole("button", { name: "Refresh files" });
    await vi.waitFor(() => expect(refresh.querySelector("svg")).not.toHaveClass("animate-spin"));

    let resolveVisibleLoad!: (entries: FileListEntry[]) => void;
    files.sidebar
      .mockImplementationOnce(() => new Promise<FileListEntry[]>((resolve) => { resolveVisibleLoad = resolve; }))
      .mockResolvedValue(sidebarEntries(["work", "reports"]));

    fireEvent.click(refresh);
    expect(refresh.querySelector("svg")).toHaveClass("animate-spin");

    const callsBeforePoll = files.sidebar.mock.calls.length;
    await vi.waitFor(() => expect(files.sidebar.mock.calls.length).toBeGreaterThan(callsBeforePoll), { timeout: 3_000 });
    await act(async () => { resolveVisibleLoad(sidebarEntries(["work", "reports"])); });

    await vi.waitFor(() => expect(refresh.querySelector("svg")).not.toHaveClass("animate-spin"));
  });

  it("copies the workspace-relative and absolute path from the row menu", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<FileBrowser cwd="/workspaces/proj" />);
    fireEvent.click(screen.getByText("Files"));
    const row = (await screen.findByText("data.csv")).closest("button")!;

    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    // The mock lists the entry with its bare name; the real API returns the
    // workspace-relative path.
    expect(writeText).toHaveBeenLastCalledWith("data.csv");

    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy absolute path" }));
    expect(writeText).toHaveBeenLastCalledWith("/workspaces/proj/data.csv");
  });

  it("reports a refused clipboard instead of failing silently", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    render(<FileBrowser cwd="/workspaces/proj" />);
    fireEvent.click(screen.getByText("Files"));
    const row = (await screen.findByText("data.csv")).closest("button")!;

    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));

    const { useFeedback } = await import("../../components/feedback/feedback-context");
    await vi.waitFor(() => expect(vi.mocked(useFeedback().toast)).toHaveBeenCalledWith("Copy failed", "error"));
  });
});

describe("FileBrowser inline create and rename", () => {
  const entry = (path: string, isDir = false): FileListEntry => ({ path, name: path.split("/").at(-1)!, isDir, size: 0, modified: 1 });
  const useTree = (root: FileListEntry[], children: Record<string, FileListEntry[]> = {}) => {
    files.sidebar.mockReset().mockResolvedValue(root);
    files.directory.mockReset().mockImplementation(async (_cwd: string, subdir: string) => ({ entries: children[subdir] ?? [], breadcrumbs: [] }));
  };
  const openMenu = (row: HTMLElement) => fireEvent.contextMenu(row, { clientX: 20, clientY: 30 });
  const menuLabels = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

  it("lists New file and New folder first in the row menu for file and folder rows", async () => {
    useTree([entry("work", true), entry("notes.md")], { work: [] });
    render(<FileBrowser cwd="/workspaces/proj" embedded />);
    for (const name of ["work", "notes.md"]) {
      const row = await screen.findByRole("button", { name });
      openMenu(row);
      await screen.findByRole("menu");
      expect(menuLabels().slice(0, 2)).toEqual(["New file", "New folder"]);
      fireEvent.keyDown(document, { key: "Escape" });
      await vi.waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    }
  });

  it("creates a folder inside the folder row the menu was opened on", async () => {
    useTree([entry("work", true)], { work: [] });
    render(<FileBrowser cwd="/workspaces/proj" embedded />);
    openMenu(await screen.findByRole("button", { name: "work" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New folder" }));
    const input = await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.change(input, { target: { value: "sub" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(files.mkdir).toHaveBeenCalledWith("/workspaces/proj", "work/sub", { exclusive: true }));
  });

  it("creates a file beside the file row the menu was opened on", async () => {
    useTree([entry("work", true)], { work: [entry("work/data.csv")] });
    render(<FileBrowser cwd="/workspaces/proj" embedded />);
    openMenu(await screen.findByRole("button", { name: "data.csv" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New file" }));
    const input = await screen.findByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "x.csv" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(files.createFile).toHaveBeenCalledWith("/workspaces/proj", "work/x.csv"));
  });

  it("renames the row in place with the current name prefilled", async () => {
    useTree([entry("data.csv")]);
    render(<FileBrowser cwd="/workspaces/proj" embedded />);
    openMenu(await screen.findByRole("button", { name: "data.csv" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Rename" });
    expect(input).toHaveValue("data.csv");
    fireEvent.change(input, { target: { value: "renamed.csv" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(files.rename).toHaveBeenCalledWith("/workspaces/proj", "data.csv", "renamed.csv"));
  });

  it("keeps a single name input when a nested create replaces an open one", async () => {
    useTree([entry("work", true)], { work: [] });
    render(<FileBrowser cwd="/workspaces/proj" embedded />);
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    expect(await screen.findAllByRole("textbox")).toHaveLength(1);
    openMenu(await screen.findByRole("button", { name: "work" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New folder" }));
    await vi.waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(1));
  });

  it("keeps the typed name and shows the inline conflict on a duplicate", async () => {
    useTree([entry("work", true)], { work: [] });
    files.createFile.mockRejectedValueOnce(new ApiError("File already exists", 409));
    render(<FileBrowser cwd="/workspaces/proj" embedded />);
    await screen.findByRole("button", { name: "work" });
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const input = await screen.findByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "dup.csv" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("A file or folder with that name already exists"));
    expect(screen.getByRole("textbox", { name: "File name" })).toHaveValue("dup.csv");
    expect(useFeedback().toast).not.toHaveBeenCalled();
  });

  it("submits exactly once when Enter is followed by blur", async () => {
    useTree([entry("work", true)], { work: [] });
    render(<FileBrowser cwd="/workspaces/proj" embedded />);
    await screen.findByRole("button", { name: "work" });
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const input = await screen.findByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "one.csv" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await vi.waitFor(() => expect(useFeedback().toast).toHaveBeenCalledWith("File \"one.csv\" created", "success"));
    expect(files.createFile).toHaveBeenCalledTimes(1);
  });
});


describe("FileBrowser external file uploads", () => {
  const entry = (path: string, isDir = false): FileListEntry => ({
    path, name: path.split("/").at(-1)!, isDir, size: 0, modified: 1,
  });
  const transfer = (names = ["experiment.csv"]) => ({
    types: ["Files"],
    files: names.map((name) => new File(["data"], name)),
    dropEffect: "none",
  });
  const leaveAt = (target: Element, dataTransfer: ReturnType<typeof transfer>, clientX: number, clientY: number) => {
    const event = createEvent.dragLeave(target, { dataTransfer });
    // jsdom has no DragEvent constructor, so set coordinates on the native event.
    Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY }, relatedTarget: { value: null } });
    fireEvent(target, event);
  };
  const rootZone = () => screen.getByLabelText("Drop files here to upload to the workspace root");
  const request = vi.mocked(apiRequest);

  beforeEach(() => {
    request.mockReset().mockResolvedValue({ ok: true });
    files.sidebar.mockReset().mockResolvedValue([entry("work", true), entry("reports", true), entry("readme.md")]);
    files.directory.mockReset().mockImplementation(async (_cwd: string, subdir: string) => ({
      entries: subdir === "work" ? [entry("work/data", true)] : [entry(`${subdir}/experiment.csv`)],
      breadcrumbs: [],
    }));
  });

  it("uploads to a collapsed nested directory, opens it, and preserves other expanded folders", async () => {
    const bubble = vi.fn();
    render(<div onDrop={bubble}><FileBrowser cwd="proj" embedded /></div>);
    const folder = await screen.findByRole("button", { name: "data" });
    const reports = screen.getByRole("button", { name: "reports" });
    fireEvent.click(reports);
    await screen.findByRole("button", { name: "experiment.csv" });
    const dataTransfer = transfer();
    fireEvent.dragEnter(folder.querySelector("span")!, { dataTransfer });
    expect(folder).toHaveAttribute("data-drop-state", "valid");
    const leaveChild = createEvent.dragLeave(folder, { dataTransfer });
    Object.defineProperty(leaveChild, "relatedTarget", { value: folder.querySelector("span") });
    fireEvent(folder, leaveChild);
    expect(folder).toHaveAttribute("data-drop-state", "valid");
    // Browsers may omit relatedTarget while moving between children.
    vi.spyOn(rootZone(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 200, bottom: 400 } as DOMRect);
    fireEvent.dragEnter(folder, { dataTransfer });
    fireEvent.dragEnter(folder.querySelector("span")!, { dataTransfer });
    leaveAt(folder, dataTransfer, 50, 80);
    expect(folder).toHaveAttribute("data-drop-state", "valid");
    fireEvent.dragOver(folder, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(folder, { dataTransfer });
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Uploaded: 1; failed/skipped: 0."));
    const [url, options] = request.mock.calls[0];
    const params = new URL(String(url), "http://localhost").searchParams;
    expect(params.get("cwd")).toBe("proj");
    expect(params.get("path")).toBe("work/data/experiment.csv");
    expect(options?.method).toBe("POST");
    expect((options!.body as FormData).get("file")).toBe(dataTransfer.files[0]);
    expect(files.invalidate).toHaveBeenCalled();
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(reports).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "work" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: "experiment.csv" })).toHaveLength(2);
    expect(folder).not.toHaveAttribute("data-drop-state");
    expect(bubble).not.toHaveBeenCalled();
    expect(useUiStore.getState().inspectorOpen).toBe(false);
    expect(useUiStore.getState().workspaceReferences).toHaveLength(0);
  });

  it("reveals root uploads without exceeding 30 entries, including on subsequent polls", async () => {
    const { workspaceFiles: realFiles } = await import("../../lib/workspace/workspace-files");
    let uploaded = false;
    const rootEntries = [...Array.from({ length: 2000 }, (_, i) => entry(`file${i}.csv`)), entry("z-upload.csv")];
    files.directory.mockImplementation(async () => ({ entries: uploaded ? rootEntries : [], breadcrumbs: [] }));
    files.sidebar.mockImplementation(realFiles.sidebar.bind({ ...realFiles, directory: files.directory }));
    request.mockImplementation(async () => { uploaded = true; return { ok: true }; });
    const view = render(<FileBrowser cwd="proj" embedded />);
    await screen.findByText("No files");
    const zone = rootZone();
    fireEvent.dragOver(zone, { dataTransfer: transfer(["z-upload.csv"]) });
    expect(zone).toHaveClass("ring-accent/60");
    fireEvent.drop(zone, { dataTransfer: transfer(["z-upload.csv"]) });
    await screen.findByRole("button", { name: "z-upload.csv" });
    expect(new URL(String(request.mock.calls[0][0]), "http://localhost").searchParams.get("path")).toBe("z-upload.csv");
    expect(screen.getAllByRole("button")).toHaveLength(33); // 30 entries, new-file, new-folder, refresh
    expect(zone).not.toHaveClass("ring-accent/60");
    vi.useFakeTimers();
    view.rerender(<FileBrowser cwd="proj" embedded active={false} />);
    view.rerender(<FileBrowser cwd="proj" embedded />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(files.sidebar).toHaveBeenLastCalledWith("proj", undefined, ["z-upload.csv"]);
    expect(screen.getAllByRole("button")).toHaveLength(33); //
    expect(screen.getByRole("button", { name: "z-upload.csv" })).toBeInTheDocument();
    view.rerender(<FileBrowser cwd="other" embedded />);
    await act(async () => {});
    expect(files.sidebar).toHaveBeenLastCalledWith("other", expect.anything(), []);
  });

  it.each([30, 50])("keeps root folders visible and usable after a batch of %i uploads and polling", async (count) => {
    const { workspaceFiles: realFiles } = await import("../../lib/workspace/workspace-files");
    const rootEntries = [entry("work", true), entry("data", true), entry("reports", true)];
    files.directory.mockImplementation(async (_cwd: string, subdir: string) => ({
      entries: subdir ? [] : [...rootEntries], breadcrumbs: [],
    }));
    files.sidebar.mockImplementation(realFiles.sidebar.bind({ ...realFiles, directory: files.directory }));
    request.mockImplementation(async (_url, options) => {
      const file = (options!.body as FormData).get("file") as File;
      rootEntries.push(entry(file.name));
      return { ok: true };
    });
    render(<FileBrowser cwd="proj" embedded />);
    const work = await screen.findByRole("button", { name: "work" });
    await vi.waitFor(() => expect(work).toHaveAttribute("aria-expanded", "true"));
    const names = Array.from({ length: count }, (_, i) => `upload${i}.csv`);
    fireEvent.drop(rootZone(), { dataTransfer: transfer(names) });
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Uploaded: ${count}; failed/skipped: 0.`));
    const assertRoot = () => {
      expect(screen.getAllByRole("button")).toHaveLength(33); // 3 folders, 27 uploads, new-file, new-folder, refresh
      for (const name of ["work", "data", "reports"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
      expect(work).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: names.at(-1)! })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: names[0] })).not.toBeInTheDocument();
    };
    assertRoot();
    expect(files.sidebar).toHaveBeenLastCalledWith("proj", expect.anything(), names.slice(-30));
    expect(files.invalidate).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    assertRoot();
    fireEvent.click(screen.getByRole("button", { name: "reports" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "reports" })).toHaveAttribute("aria-expanded", "true");
    expect(files.directory).toHaveBeenLastCalledWith("proj", "reports");
  });

  it.each([false, true])("prevents file navigation on the header when embedded=%s", async (embedded) => {
    const bubble = vi.fn();
    render(<div onDrop={bubble}><FileBrowser cwd="proj" embedded={embedded} /></div>);
    if (embedded) await screen.findByRole("button", { name: "reports" });
    const header = embedded ? screen.getByText("Files") : screen.getByRole("button", { name: "Files" });
    for (const target of [header, screen.getByRole("button", { name: "Refresh files" })]) {
      const dataTransfer = transfer();
      const over = createEvent.dragOver(target, { dataTransfer });
      fireEvent(target, over);
      expect(over.defaultPrevented).toBe(true);
      expect(dataTransfer.dropEffect).toBe("none");
      const drop = createEvent.drop(target, { dataTransfer });
      fireEvent(target, drop);
      expect(drop.defaultPrevented).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
    expect(bubble).not.toHaveBeenCalled();
    const textDrop = createEvent.drop(header, { dataTransfer: { types: ["text/plain"], files: [] } });
    fireEvent(header, textDrop);
    expect(textDrop.defaultPrevented).toBe(false);
    expect(bubble).toHaveBeenCalledTimes(1);
  });

  it("prevents file navigation on the upload status without starting another upload", async () => {
    render(<FileBrowser cwd="proj" embedded />);
    const folder = await screen.findByRole("button", { name: "reports" });
    fireEvent.drop(folder, { dataTransfer: transfer() });
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Uploaded: 1"));
    const drop = createEvent.drop(screen.getByRole("status"), { dataTransfer: transfer() });
    fireEvent(screen.getByRole("status"), drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uploads the entire batch before refreshing expanded directories once", async () => {
    render(<FileBrowser cwd="proj" embedded />);
    await screen.findByRole("button", { name: "data" });
    fireEvent.click(screen.getByRole("button", { name: "reports" }));
    await screen.findByRole("button", { name: "experiment.csv" });
    let finishRefresh!: (entries: FileListEntry[]) => void;
    files.sidebar.mockClear().mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    files.directory.mockClear();
    fireEvent.drop(screen.getByRole("button", { name: "reports" }), { dataTransfer: transfer(["one.csv", "two.csv", "three.csv"]) });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(files.invalidate).toHaveBeenCalledTimes(1);
    expect(files.sidebar).toHaveBeenCalledTimes(1);
    expect(files.directory).not.toHaveBeenCalled();
    await act(async () => finishRefresh([entry("work", true), entry("reports", true)]));
    expect(files.directory).toHaveBeenCalledTimes(2);
    expect(files.directory).toHaveBeenCalledWith("proj", "work", expect.anything());
    expect(files.directory).toHaveBeenCalledWith("proj", "reports", expect.anything());
    expect(screen.getByRole("status")).toHaveTextContent("Uploaded: 3; failed/skipped: 0.");
  });

  it("clears a nested drag leaving the tree with no relatedTarget or window drop", async () => {
    render(<FileBrowser cwd="proj" embedded />);
    const folder = await screen.findByRole("button", { name: "reports" });
    const zone = rootZone();
    vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({ left: 10, top: 10, right: 210, bottom: 410 } as DOMRect);
    for (const target of [zone, folder, folder.querySelector("span")!, folder.querySelector("svg")!]) {
      fireEvent.dragEnter(target, { dataTransfer: transfer(), clientX: 50, clientY: 80 });
    }
    expect(folder).toHaveAttribute("data-drop-state", "valid");
    leaveAt(folder.querySelector("span")!, transfer(), 50, 80);
    expect(folder).toHaveAttribute("data-drop-state", "valid");
    leaveAt(zone, transfer(), -5, 80);
    expect(folder).not.toHaveAttribute("data-drop-state");
    fireEvent.dragEnter(zone, { dataTransfer: transfer(), clientX: 50, clientY: 80 });
    expect(zone).toHaveClass("ring-accent/60");
    leaveAt(zone, transfer(), 0, 0);
    expect(zone).not.toHaveClass("ring-accent/60");
  });

  it("rejects ordinary file targets without bubbling or uploading to root", async () => {
    render(<FileBrowser cwd="proj" embedded />);
    const file = await screen.findByRole("button", { name: "readme.md" });
    const dataTransfer = transfer();
    fireEvent.dragOver(file, { dataTransfer });
    expect(file).toHaveAttribute("data-drop-state", "invalid");
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.drop(file, { dataTransfer });
    expect(request).not.toHaveBeenCalled();
    expect(file).not.toHaveAttribute("data-drop-state");
  });

  it("continues a batch after conflicts, size errors, network and path failures, and reports filenames", async () => {
    request.mockRejectedValueOnce(new ApiError("exists", 409))
      .mockRejectedValueOnce(new ApiError("large", 413))
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockRejectedValueOnce(new ApiError("Path outside workspace", 403))
      .mockResolvedValueOnce({ ok: true });
    render(<FileBrowser cwd="proj" embedded />);
    const folder = await screen.findByRole("button", { name: "reports" });
    fireEvent.drop(folder, { dataTransfer: transfer(["exists.csv", "large.pdf", "network.csv", "bad.csv", "experiment.csv"]) });
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Uploaded: 1; failed/skipped: 4."));
    expect(screen.getByRole("status")).toHaveTextContent("exists.csv: Skipped: a file with this name already exists");
    expect(screen.getByRole("status")).toHaveTextContent("large.pdf: Request exceeds the upload limit (default 10 MiB including form data)");
    expect(screen.getByRole("status")).toHaveTextContent("network.csv: Network unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("bad.csv: Path outside workspace");
    expect(request).toHaveBeenCalledTimes(5);
    expect(useFeedback().toast).toHaveBeenCalledWith(expect.stringContaining("Uploaded: 1; failed/skipped: 4."), "error");
    expect(folder).not.toHaveAttribute("data-drop-state");
    await screen.findByRole("button", { name: "experiment.csv" });
  });

  it("shows progress, disallows overlapping uploads, and clears state after all uploads fail", async () => {
    let reject!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<FileBrowser cwd="proj" embedded />);
    const folder = await screen.findByRole("button", { name: "reports" });
    fireEvent.drop(folder, { dataTransfer: transfer() });
    expect(screen.getByRole("status")).toHaveTextContent("Uploading 1/1: experiment.csv");
    expect(rootZone()).toHaveAttribute("aria-busy", "true");
    fireEvent.drop(folder, { dataTransfer: transfer() });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("offline")));
    expect(screen.getByRole("status")).toHaveTextContent("Uploaded: 0; failed/skipped: 1.");
    expect(rootZone()).toHaveAttribute("aria-busy", "false");
    expect(files.invalidate).not.toHaveBeenCalled();
  });

  it("clears highlights on leave, Escape, drag cancellation and workspace changes", async () => {
    const view = render(<FileBrowser cwd="proj" embedded />);
    const folder = await screen.findByRole("button", { name: "reports" });
    for (const clear of [
      () => fireEvent.dragLeave(rootZone(), { dataTransfer: transfer(), relatedTarget: document.body }),
      () => fireEvent.keyDown(window, { key: "Escape" }),
      () => fireEvent.dragEnd(window),
      () => fireEvent.drop(window),
    ]) {
      fireEvent.dragOver(folder, { dataTransfer: transfer() });
      expect(folder).toHaveAttribute("data-drop-state", "valid");
      clear();
      expect(folder).not.toHaveAttribute("data-drop-state");
    }
    fireEvent.dragOver(folder, { dataTransfer: transfer() });
    view.rerender(<FileBrowser cwd="other" embedded />);
    expect(folder).not.toHaveAttribute("data-drop-state");
  });

  it("does not intercept text or internal link drags", async () => {
    const bubble = vi.fn();
    render(<div onDrop={bubble}><FileBrowser cwd="proj" embedded /></div>);
    const folder = await screen.findByRole("button", { name: "reports" });
    const dataTransfer = { types: ["text/uri-list"], files: [] };
    fireEvent.dragOver(folder, { dataTransfer });
    expect(folder).not.toHaveAttribute("data-drop-state");
    fireEvent.drop(folder, { dataTransfer });
    expect(bubble).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts an old workspace batch without applying its results to the new workspace", async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<FileBrowser cwd="proj" embedded />);
    const folder = await screen.findByRole("button", { name: "reports" });
    fireEvent.drop(folder, { dataTransfer: transfer(["one.csv", "two.csv"]) });
    const signal = request.mock.calls[0][1]?.signal;
    view.rerender(<FileBrowser cwd="other" embedded />);
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ ok: true }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(useFeedback().toast).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "reports" })).toHaveAttribute("aria-expanded", "false");
  });

  it("rejects directory drops and synthetic path names while continuing with real files", async () => {
    render(<FileBrowser cwd="proj" embedded />);
    const folder = await screen.findByRole("button", { name: "reports" });
    const dataTransfer = {
      types: ["Files"], files: [],
      items: [
        { kind: "file", webkitGetAsEntry: () => ({ name: "data", isDirectory: true }) },
        ...["../escape.csv", "experiment.csv"].map((name) => ({ kind: "file", getAsFile: () => new File(["x"], name) })),
      ],
    };
    fireEvent.drop(folder, { dataTransfer });
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Uploaded: 1; failed/skipped: 2."));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("data: Folder uploads are not supported");
    expect(screen.getByRole("status")).toHaveTextContent("../escape.csv: Invalid file name");
  });
});
