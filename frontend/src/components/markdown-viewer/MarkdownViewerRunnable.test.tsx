import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/notebook", () => ({ notebookRuntime: { execute } }));

const RESULT = { ok: true, stdout: "42\n", result: null, error: null };

describe("MarkdownViewer runnable code across streaming frames", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFrames(): { flush: () => void } {
    let paint: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      paint = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    return { flush: () => act(() => paint?.(16)) };
  }

  it("keeps a run in flight and shows its output after later deltas", async () => {
    const frames = stubFrames();
    let resolveRun: (value: typeof RESULT) => void = () => {};
    execute.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
    const base = "```python\nprint(42)\n```\n\nNarration";
    const runner = { cwd: "/workspace", sessionId: "s1" };

    const { rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{base}</MarkdownViewer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();

    rerender(<MarkdownViewer mode="streaming" codeRunner={runner}>{`${base} continues`}</MarkdownViewer>);
    frames.flush();

    // A remount would reset `running` and offer a second Run for the same block.
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    expect(execute).toHaveBeenCalledTimes(1);

    await act(async () => { resolveRun(RESULT); });
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });

  it("keeps a pending run across the streaming-to-final transition", () => {
    execute.mockReturnValue(new Promise(() => {}));
    const base = "```python\nprint(42)\n```\n\nNarration";
    const runner = { cwd: "/workspace", sessionId: "s1" };

    const { rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{base}</MarkdownViewer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    rerender(<MarkdownViewer mode="final" codeRunner={runner}>{base}</MarkdownViewer>);

    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("executes only once when a delta lands while the run is pending", async () => {
    const frames = stubFrames();
    execute.mockReturnValue(new Promise(() => {}));
    const base = "```python\nprint(42)\n```\n\nNarration";
    const runner = { cwd: "/workspace", sessionId: "s1" };

    const { rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{base}</MarkdownViewer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    rerender(<MarkdownViewer mode="streaming" codeRunner={runner}>{`${base} more`}</MarkdownViewer>);
    frames.flush();

    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not show a result under code that replaced it mid-run", async () => {
    const frames = stubFrames();
    let resolveRun: (value: typeof RESULT) => void = () => {};
    execute.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
    const runner = { cwd: "/workspace", sessionId: "s1" };

    const { rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{"```python\nprint(1)\n```\n\nNarration"}</MarkdownViewer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    rerender(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{"```python\nprint(2)\n```\n\nNarration"}</MarkdownViewer>,
    );
    frames.flush();

    await act(async () => { resolveRun(RESULT); });
    expect(screen.queryByText("42")).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
  });
});
