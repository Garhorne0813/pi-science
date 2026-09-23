import type { ComponentProps } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const renderPipeline = vi.hoisted(() => vi.fn());

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const ActualMarkdown = actual.default;
  return {
    ...actual,
    default: (props: ComponentProps<typeof ActualMarkdown>) => {
      renderPipeline();
      return <ActualMarkdown {...props} />;
    },
  };
});

import { MarkdownViewer } from "./MarkdownViewer";

afterEach(() => {
  vi.unstubAllGlobals();
  renderPipeline.mockClear();
});

describe("MarkdownViewer streaming render coalescing", () => {
  it("runs the Markdown pipeline only after the animation frame advances", () => {
    let paint: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      paint = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { rerender } = render(<MarkdownViewer mode="streaming">{"one"}</MarkdownViewer>);
    expect(renderPipeline).toHaveBeenCalledTimes(1);

    rerender(<MarkdownViewer mode="streaming">{"two"}</MarkdownViewer>);
    rerender(<MarkdownViewer mode="streaming">{"three"}</MarkdownViewer>);
    expect(renderPipeline).toHaveBeenCalledTimes(1);

    act(() => paint?.(16));
    expect(renderPipeline).toHaveBeenCalledTimes(2);
  });
});
