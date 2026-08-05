import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NotebookEditor } from "./NotebookEditor";
import { readArtifact } from "../../lib/files";
import i18n from "../../i18n";

vi.mock("../../lib/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/files")>();
  return { ...actual, readArtifact: vi.fn() };
});

const readArtifactMock = vi.mocked(readArtifact);

const NOTEBOOK_V1 = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  cells: [{ cell_type: "code", source: ["print(1)"], metadata: { custom: "keep" } }],
  metadata: { kernelspec: { name: "python3", language: "python" } },
});

const NOTEBOOK_V2 = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  cells: [
    { cell_type: "code", source: ["print(1)"], metadata: { custom: "keep" } },
    { cell_type: "markdown", source: ["# Saved from chat"], metadata: {} },
    { cell_type: "code", source: ['print("hello")'], execution_count: 1, outputs: [{ output_type: "stream", name: "stdout", text: ["hello\n"] }] },
  ],
  metadata: { kernelspec: { name: "python3", language: "python" } },
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  readArtifactMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NotebookEditor revision reload", () => {
  it("renders cells from the first read and reloads when revision changes", async () => {
    readArtifactMock.mockResolvedValueOnce({ path: "n.ipynb", name: "n.ipynb", encoding: "utf8", data: NOTEBOOK_V1, size: 10, modified: "t1" } as never);
    readArtifactMock.mockResolvedValueOnce({ path: "n.ipynb", name: "n.ipynb", encoding: "utf8", data: NOTEBOOK_V2, size: 20, modified: "t2" } as never);

    const { rerender } = render(<NotebookEditor path="notebooks/n.ipynb" cwd="/tmp/lab" onClose={() => undefined} revision={1} />);
    await waitFor(() => expect(screen.getByText("print(1)")).toBeInTheDocument());
    expect(readArtifactMock).toHaveBeenCalledTimes(1);

    // Same path stays open; a new revision must trigger a fresh read.
    rerender(<NotebookEditor path="notebooks/n.ipynb" cwd="/tmp/lab" onClose={() => undefined} revision={2} />);
    await waitFor(() => expect(readArtifactMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Saved from chat")).toBeInTheDocument());
    expect(screen.getByText('print("hello")')).toBeInTheDocument();
  });

  it("does not reload when revision is unchanged", async () => {
    readArtifactMock.mockResolvedValue({ path: "n.ipynb", name: "n.ipynb", encoding: "utf8", data: NOTEBOOK_V1, size: 10, modified: "t1" } as never);

    const { rerender } = render(<NotebookEditor path="notebooks/n.ipynb" cwd="/tmp/lab" onClose={() => undefined} revision={1} />);
    await waitFor(() => expect(screen.getByText("print(1)")).toBeInTheDocument());
    rerender(<NotebookEditor path="notebooks/n.ipynb" cwd="/tmp/lab" onClose={() => undefined} revision={1} />);
    expect(readArtifactMock).toHaveBeenCalledTimes(1);
  });

  it("keeps extra notebook-format fields through a tolerant parse", async () => {
    readArtifactMock.mockResolvedValue({ path: "n.ipynb", name: "n.ipynb", encoding: "utf8", data: NOTEBOOK_V2, size: 20, modified: "t2" } as never);
    render(<NotebookEditor path="notebooks/n.ipynb" cwd="/tmp/lab" onClose={() => undefined} revision={1} />);
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
  });
});
