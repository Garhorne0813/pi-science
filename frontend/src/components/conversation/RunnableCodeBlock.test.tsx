import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunnableCodeBlock } from "./RunnableCodeBlock";
import { FeedbackProvider } from "../feedback/FeedbackProvider";
import { type CellResult } from "../../lib/notebook";
import { useUiStore } from "../../lib/ui";
import i18n from "../../i18n";

const saveChatCell = vi.fn();
const execute = vi.fn();

vi.mock("../../lib/notebook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/notebook")>();
  return {
    ...actual,
    notebookRuntime: {
      ...actual.notebookRuntime,
      saveChatCell: (...args: unknown[]) => saveChatCell(...args),
      execute: (...args: unknown[]) => execute(...args),
    },
  };
});

function renderBlock(overrides: { messageId?: string; messageComplete?: boolean; sourceLine?: number; modelAtSave?: string } = {}) {
  return render(
    <FeedbackProvider>
      <RunnableCodeBlock
        code={'print("hello")'}
        cwd="/tmp/lab"
        sessionId="sess-1"
        messageId={"messageId" in overrides ? overrides.messageId : "msg-1"}
        messageComplete={overrides.messageComplete ?? true}
        sourceLine={overrides.sourceLine}
        modelAtSave={overrides.modelAtSave ?? "custom-gpt/gpt-5.6-luna"}
      >
        {"print(\"hello\")"}
      </RunnableCodeBlock>
    </FeedbackProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  saveChatCell.mockReset();
  execute.mockReset();
  useUiStore.setState({ openInspector: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunnableCodeBlock save-to-notebook", () => {
  it("hides the Save button without a settled agent message", () => {
    renderBlock({ messageId: undefined });
    expect(screen.queryByLabelText("Save to notebook")).toBeNull();
  });

  it("hides the Save button while the message is still streaming", () => {
    renderBlock({ messageComplete: false });
    expect(screen.queryByLabelText("Save to notebook")).toBeNull();
  });

  it("shows Run and Save actions for a settled message", () => {
    renderBlock();
    expect(screen.getByLabelText("Run")).toBeInTheDocument();
    expect(screen.getByLabelText("Save to notebook")).toBeInTheDocument();
  });

  it("saves code without a run result when executed never ran", async () => {
    saveChatCell.mockResolvedValue({ ok: true, path: "notebooks/sess-1.ipynb", created_notebook: true, appended: false, updated: false, cell_index: 0, cell_count: 1, revision: 7 });
    renderBlock({ sourceLine: 12 });
    fireEvent.click(screen.getByLabelText("Save to notebook"));
    await waitFor(() => expect(saveChatCell).toHaveBeenCalledTimes(1));
    const [cwd, request] = saveChatCell.mock.calls[0] as [string, Record<string, unknown>];
    expect(cwd).toBe("/tmp/lab");
    expect(request.session_id).toBe("sess-1");
    expect(request.message_id).toBe("msg-1");
    expect(request.source_line).toBe(12);
    expect(request.code).toBe('print("hello")');
    expect(request.result).toBeUndefined();
    expect(request.model_at_save).toBe("custom-gpt/gpt-5.6-luna");
  });

  it("attaches the last run result when the block was executed first", async () => {
    const result: CellResult = { ok: true, stdout: "42\n", result: null, error: null };
    execute.mockResolvedValue(result);
    saveChatCell.mockResolvedValue({ ok: true, path: "notebooks/sess-1.ipynb", created_notebook: false, appended: true, updated: false, cell_index: 3, cell_count: 4, revision: 8 });
    renderBlock();
    fireEvent.click(screen.getByLabelText("Run"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText("Save to notebook"));
    await waitFor(() => expect(saveChatCell).toHaveBeenCalledTimes(1));
    const request = saveChatCell.mock.calls[0]![1] as { result?: CellResult };
    expect(request.result).toEqual(result);
  });

  it("disables Run while saving and opens the notebook inspector on success", async () => {
    let release!: () => void;
    saveChatCell.mockReturnValue(new Promise((resolve) => { release = () => resolve({ ok: true, path: "notebooks/sess-1.ipynb", created_notebook: true, appended: false, updated: false, cell_index: 0, cell_count: 1, revision: 5 }); }));
    const openSpy = vi.fn();
    useUiStore.setState({ openInspector: openSpy });
    renderBlock();
    fireEvent.click(screen.getByLabelText("Save to notebook"));
    expect(screen.getByLabelText("Run")).toBeDisabled();
    expect(screen.getByLabelText("Save to notebook")).toBeDisabled();
    release();
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const inspector = openSpy.mock.calls[0]![0] as { variant: string; path: string; revision?: number };
    expect(inspector.variant).toBe("notebook-file");
    expect(inspector.path).toBe("notebooks/sess-1.ipynb");
    expect(inspector.revision).toBe(5);
  });

  it("becomes Open-notebook after saving and reopens the inspector on click", async () => {
    saveChatCell.mockResolvedValue({ ok: true, path: "notebooks/sess-1.ipynb", created_notebook: true, appended: false, updated: false, cell_index: 0, cell_count: 1, revision: 9 });
    const openSpy = vi.fn();
    useUiStore.setState({ openInspector: openSpy });
    renderBlock();
    fireEvent.click(screen.getByLabelText("Save to notebook"));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Open notebook")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open notebook"));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(2));
    expect(openSpy.mock.calls[1]![0].path).toBe("notebooks/sess-1.ipynb");
  });

  it("shows the error state and keeps the Save action retryable", async () => {
    saveChatCell.mockRejectedValueOnce(new Error("boom"));
    saveChatCell.mockResolvedValueOnce({ ok: true, path: "notebooks/sess-1.ipynb", created_notebook: true, appended: false, updated: false, cell_index: 0, cell_count: 1, revision: 2 });
    const openSpy = vi.fn();
    useUiStore.setState({ openInspector: openSpy });
    renderBlock();
    fireEvent.click(screen.getByLabelText("Save to notebook"));
    await waitFor(() => expect(saveChatCell).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Save to notebook")).toBeInTheDocument();
    expect(screen.getByLabelText("Save to notebook").className).toContain("text-error");
    // Retry succeeds.
    fireEvent.click(screen.getByLabelText("Save to notebook"));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
  });

  it("resets the saved state when the block is re-run", async () => {
    saveChatCell.mockResolvedValue({ ok: true, path: "notebooks/sess-1.ipynb", created_notebook: true, appended: false, updated: false, cell_index: 0, cell_count: 1, revision: 1 });
    execute.mockResolvedValue({ ok: true, stdout: "new", result: null, error: null });
    const openSpy = vi.fn();
    useUiStore.setState({ openInspector: openSpy });
    renderBlock();
    fireEvent.click(screen.getByLabelText("Save to notebook"));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Open notebook")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Run"));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Save to notebook")).toBeInTheDocument();
  });
});
