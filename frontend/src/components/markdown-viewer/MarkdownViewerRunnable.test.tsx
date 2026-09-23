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

  function shellForCode(container: HTMLElement, code: string): HTMLElement {
    const pre = [...container.querySelectorAll("pre")].find((candidate) => candidate.textContent?.includes(code));
    const shell = pre?.closest(".relative");
    if (!(shell instanceof HTMLElement)) throw new Error(`Missing runnable shell for ${code}`);
    return shell;
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

  it("lets edited code run while the previous snapshot is still pending", async () => {
    const frames = stubFrames();
    let resolveFirst: (value: typeof RESULT) => void = () => {};
    let resolveSecond: (value: typeof RESULT) => void = () => {};
    execute
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    const runner = { cwd: "/workspace", sessionId: "s1" };

    const { rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{"```python\nprint(1)\n```"}</MarkdownViewer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    rerender(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{"```python\nprint(2)\n```"}</MarkdownViewer>,
    );
    frames.flush();

    const run = screen.getByRole("button", { name: "Run" });
    expect(run).toBeEnabled();
    fireEvent.click(run);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();

    await act(async () => { resolveFirst(RESULT); });
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    expect(screen.queryByText("42")).toBeNull();

    await act(async () => { resolveSecond({ ...RESULT, stdout: "2\n" }); });
    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());
  });

  it("keeps a pending run with its fence when a replacement prepends another fence", async () => {
    const frames = stubFrames();
    let resolveRun: (value: typeof RESULT) => void = () => {};
    execute.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
    const runner = { cwd: "/workspace", sessionId: "s1" };
    const original = "```python\nprint('A')\n```\n\nNarration";
    const replacement = "```python\nprint('B')\n```\n\n```python\nprint('A')\n```\n\nNarration";

    const { container, rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{original}</MarkdownViewer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    rerender(<MarkdownViewer mode="streaming" codeRunner={runner}>{replacement}</MarkdownViewer>);
    frames.flush();

    expect(shellForCode(container, "print('B')").querySelector('[aria-label="Run"]')).toBeInTheDocument();
    expect(shellForCode(container, "print('A')").querySelector('[aria-label="Running…"]')).toBeInTheDocument();
    expect(execute).toHaveBeenCalledTimes(1);

    await act(async () => { resolveRun(RESULT); });
    await waitFor(() => expect(shellForCode(container, "print('A')")).toHaveTextContent("42"));
    expect(shellForCode(container, "print('B')")).not.toHaveTextContent("42");
  });

  it("does not transfer a pending run to the remaining fence when its origin is deleted", async () => {
    const frames = stubFrames();
    let resolveRun: (value: typeof RESULT) => void = () => {};
    execute.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
    const runner = { cwd: "/workspace", sessionId: "s1" };
    const original = "```python\nprint('A')\n```\n\n```python\nprint('B')\n```";
    const replacement = "```python\nprint('B')\n```";

    const { container, rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{original}</MarkdownViewer>,
    );
    fireEvent.click(shellForCode(container, "print('A')").querySelector('[aria-label="Run"]')!);
    rerender(<MarkdownViewer mode="streaming" codeRunner={runner}>{replacement}</MarkdownViewer>);
    frames.flush();

    expect(shellForCode(container, "print('B')").querySelector('[aria-label="Run"]')).toBeInTheDocument();
    expect(shellForCode(container, "print('B')").querySelector('[aria-label="Running…"]')).not.toBeInTheDocument();

    await act(async () => { resolveRun(RESULT); });
    expect(container).not.toHaveTextContent("42");
  });

  it("keeps a pending run with its fence when closed fences reorder", () => {
    const frames = stubFrames();
    execute.mockReturnValue(new Promise(() => {}));
    const runner = { cwd: "/workspace", sessionId: "s1" };
    const original = "```python\nprint('A')\n```\n\n```python\nprint('B')\n```";
    const replacement = "```python\nprint('B')\n```\n\n```python\nprint('A')\n```";

    const { container, rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{original}</MarkdownViewer>,
    );
    fireEvent.click(shellForCode(container, "print('B')").querySelector('[aria-label="Run"]')!);
    rerender(<MarkdownViewer mode="streaming" codeRunner={runner}>{replacement}</MarkdownViewer>);
    frames.flush();

    expect(shellForCode(container, "print('B')").querySelector('[aria-label="Running…"]')).toBeInTheDocument();
    expect(shellForCode(container, "print('A')").querySelector('[aria-label="Run"]')).toBeInTheDocument();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not transfer pending state across an equal-sized multi-fence rewrite", () => {
    const frames = stubFrames();
    execute.mockReturnValue(new Promise(() => {}));
    const runner = { cwd: "/workspace", sessionId: "s1" };
    const original = "```python\nprint('A')\n```\n\n```python\nprint('B')\n```";
    const replacement = "```python\nprint('X')\n```\n\n```python\nprint('Y')\n```";

    const { container, rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{original}</MarkdownViewer>,
    );
    fireEvent.click(shellForCode(container, "print('A')").querySelector('[aria-label="Run"]')!);
    rerender(<MarkdownViewer mode="streaming" codeRunner={runner}>{replacement}</MarkdownViewer>);
    frames.flush();

    expect(shellForCode(container, "print('X')").querySelector('[aria-label="Run"]')).toBeInTheDocument();
    expect(shellForCode(container, "print('Y')").querySelector('[aria-label="Run"]')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Running…"]')).not.toBeInTheDocument();
  });

  it("does not move a pending run onto a newly inserted identical fence", () => {
    const frames = stubFrames();
    execute.mockReturnValue(new Promise(() => {}));
    const runner = { cwd: "/workspace", sessionId: "s1" };
    const code = "```python\nprint('same')\n```";

    const { container, rerender } = render(
      <MarkdownViewer mode="streaming" codeRunner={runner}>{code}</MarkdownViewer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    rerender(<MarkdownViewer mode="streaming" codeRunner={runner}>{`${code}\n\n${code}`}</MarkdownViewer>);
    frames.flush();

    expect(container.querySelectorAll('[aria-label="Run"]')).toHaveLength(2);
    expect(container.querySelector('[aria-label="Running…"]')).not.toBeInTheDocument();
  });
});
