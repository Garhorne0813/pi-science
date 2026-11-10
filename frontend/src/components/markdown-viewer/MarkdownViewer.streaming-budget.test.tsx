import type { ComponentProps } from "react";
import { render } from "@testing-library/react";
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
import {
  STREAMING_PLAIN_TEXT_MAX_BYTES,
  STREAMING_PLAIN_TEXT_MAX_LINES,
  exceedsStreamingMarkdownBudget,
} from "./streaming-markdown";

afterEach(() => {
  renderPipeline.mockClear();
});

const lines = (count: number): string => Array.from({ length: count }, (_, index) => `LINE ${index + 1} | streaming body`).join("\n");
const squashed = (text: string | null): string => (text ?? "").replace(/\s+/g, "");

describe("streaming render budget", () => {
  it("crosses at the first of the byte and line limits", () => {
    expect(exceedsStreamingMarkdownBudget("a".repeat(STREAMING_PLAIN_TEXT_MAX_BYTES))).toBe(false);
    expect(exceedsStreamingMarkdownBudget("a".repeat(STREAMING_PLAIN_TEXT_MAX_BYTES + 1))).toBe(true);
    // Bytes, not code units: CJK text reaches the budget with a third of the characters.
    expect(exceedsStreamingMarkdownBudget("中".repeat(5461))).toBe(false);
    expect(exceedsStreamingMarkdownBudget("中".repeat(5462))).toBe(true);
    expect(exceedsStreamingMarkdownBudget(lines(STREAMING_PLAIN_TEXT_MAX_LINES))).toBe(false);
    expect(exceedsStreamingMarkdownBudget(lines(STREAMING_PLAIN_TEXT_MAX_LINES + 1))).toBe(true);
  });

  it("shows an over-budget streaming buffer as plain text without running the Markdown pipeline", () => {
    const text = lines(500);
    const { container } = render(<MarkdownViewer mode="streaming">{text}</MarkdownViewer>);
    const plain = container.querySelector('[data-streaming="plain"]');
    expect(plain).not.toBeNull();
    expect(plain?.textContent).toBe(text);
    expect(renderPipeline).toHaveBeenCalledTimes(0);
  });

  it("keeps Markdown for a streaming buffer inside the budget", () => {
    const text = lines(20);
    const { container } = render(<MarkdownViewer mode="streaming">{text}</MarkdownViewer>);
    expect(container.querySelector('[data-streaming="plain"]')).toBeNull();
    expect(renderPipeline).toHaveBeenCalledTimes(1);
  });

  it("renders the settled message as Markdown with the same characters", () => {
    const text = lines(500);
    const { container, rerender } = render(<MarkdownViewer mode="streaming">{text}</MarkdownViewer>);
    const streamed = squashed(container.textContent);
    rerender(<MarkdownViewer mode="final">{text}</MarkdownViewer>);
    expect(container.querySelector('[data-streaming="plain"]')).toBeNull();
    expect(renderPipeline).toHaveBeenCalledTimes(1);
    expect(squashed(container.textContent)).toBe(streamed);
  });
});
