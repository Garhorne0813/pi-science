import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n, { i18nReady } from "../../i18n";
import { readArtifact } from "../../lib/files";
import { notebookRuntime } from "../../lib/notebook";
import { NotebookEditor } from "./NotebookEditor";
import { NotebookPanel } from "../inspector/NotebookPanel";

const queries = vi.hoisted(() => ({ executions: [] as unknown[] }));
vi.mock("../../lib/files", () => ({ readArtifact: vi.fn(), writeArtifact: vi.fn() }));
vi.mock("../../lib/notebook", () => ({ notebookRuntime: { capabilities: vi.fn(), executeStreaming: vi.fn(), release: vi.fn(), interrupt: vi.fn() } }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({ ...await importOriginal<typeof import("@tanstack/react-query")>(), useQuery: () => ({ data: queries.executions }) }));

beforeEach(async () => {
  await i18nReady; await i18n.changeLanguage("en"); window.localStorage.clear(); vi.clearAllMocks(); queries.executions = [];
  vi.mocked(notebookRuntime.capabilities).mockResolvedValue({ python: true, r: false });
  vi.mocked(readArtifact).mockResolvedValue({ encoding: "utf8", data: JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", language: "python", display_name: "Python" } }, cells: [{ cell_type: "code", source: "print(1)", metadata: {}, outputs: [], execution_count: null }] }) } as Awaited<ReturnType<typeof readArtifact>>);
});
afterEach(() => { cleanup(); });

const notice = "Output was truncated. Some text is not shown.";

describe("notebook truncation notices", () => {
  it.each([true, false])("shows the editor notice only when truncated is %s, even without text", async (truncated) => {
    vi.mocked(notebookRuntime.executeStreaming).mockResolvedValue({ ok: true, stdout: "", result: null, error: null, stream_transport: { bytes_dropped: truncated ? 10 : 0, truncated } });
    render(<NotebookEditor path="example.ipynb" cwd="." onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run code cell 1" }));
    await waitFor(() => expect(notebookRuntime.executeStreaming).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryAllByText(notice)).toHaveLength(truncated ? 1 : 0));
    expect(await screen.findByRole("button", { name: "Run code cell 1" })).toBeInTheDocument();
  });

  it.each([true, false])("shows the panel notice only when truncated is %s", async (truncated) => {
    vi.mocked(notebookRuntime.executeStreaming).mockResolvedValue({ ok: true, stdout: "finished", result: null, error: null, stream_transport: { bytes_dropped: truncated ? 10 : 0, truncated } });
    render(<NotebookPanel cwd="." notebookId="truncation-test" onClose={() => {}} />);
    const draft = screen.getByPlaceholderText("Run code in this shared kernel…");
    fireEvent.change(draft, { target: { value: "print(1)" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("finished"); expect(screen.queryAllByText(notice)).toHaveLength(truncated ? 1 : 0);
  });

  it("keeps the notice visible when the panel reads stored execution evidence", async () => {
    queries.executions = [{ kind: "kernel_cell", execution_id: "exec_stored", status: "succeeded", surface: "python", request: { code: "print(1)", source: "session_notebook" }, result: { stdout_preview: "stored output" }, files: { written: [] }, usage: { stream_transport: { truncated: true, bytes_dropped: 10 } } }];
    render(<NotebookPanel cwd="." notebookId="truncation-test" onClose={() => {}} />);
    expect(screen.getByText("stored output")).toBeInTheDocument(); expect(screen.getAllByText(notice)).toHaveLength(1);
  });

  it("uses the Chinese notice text", async () => {
    await i18n.changeLanguage("zh-Hans");
    vi.mocked(notebookRuntime.executeStreaming).mockResolvedValue({ ok: true, stdout: "", result: null, error: null, stream_transport: { truncated: true } });
    render(<NotebookEditor path="example.ipynb" cwd="." onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "运行代码单元格 1" }));
    expect(await screen.findByText("输出已截断。部分内容未显示。")).toBeInTheDocument();
  });
});
