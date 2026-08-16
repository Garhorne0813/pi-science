import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { ConversationStatsLine } from "./ConversationStatsLine";
import type { SessionStats } from "../../lib/client/pi-science-client";

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    userMessages: 3,
    assistantMessages: 4,
    toolCalls: 7,
    toolResults: 7,
    totalMessages: 16,
    tokens: { input: 50_000, output: 10_000, cacheRead: 40_000, cacheWrite: 5_000, total: 105_000 },
    cost: 0.45,
    llmMs: 60_000,
    toolMs: 25_000,
    ttftMs: 300,
    ttftSteps: 4,
    decodeMs: 52_000,
    ...overrides,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

describe("ConversationStatsLine", () => {
  it("renders nothing for a null stats or an empty session (hero state)", () => {
    const { rerender } = render(<ConversationStatsLine stats={null} />);
    expect(screen.queryByLabelText("Session stats")).toBeNull();
    rerender(<ConversationStatsLine stats={stats({ userMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })} />);
    expect(screen.queryByLabelText("Session stats")).toBeNull();
  });

  it("renders the DeepSeek-aligned single line: turns/steps, timing, speed, billing", () => {
    render(<ConversationStatsLine stats={stats()} />);
    const line = screen.getByLabelText("Session stats");
    expect(line.textContent).toBe(
      "3 turns · 4 steps | LLM 1m0s · Tool call 25.0s | TTFT avg 0.1s · 192 tok/s | Cache hit 42% · Input 50.0K tok · Output 10.0K tok",
    );
    // Single-line UI: nowrap, hidden overflow, ellipsis, centered, composer width.
    expect(line).toHaveClass("whitespace-nowrap", "overflow-hidden", "text-ellipsis", "text-center");
    expect(line).toHaveClass("text-[12px]", "leading-[20px]", "max-w-[var(--conversation-composer-width)]");
  });

  it("formats sub-minute durations with one decimal and minute durations as 2m42s", () => {
    const { rerender } = render(<ConversationStatsLine stats={stats({ llmMs: 45_200, toolMs: 3_500 })} />);
    let text = screen.getByLabelText("Session stats").textContent ?? "";
    expect(text).toContain("LLM 45.2s · Tool call 3.5s");
    rerender(<ConversationStatsLine stats={stats({ llmMs: 162_000, toolMs: 0 })} />);
    text = screen.getByLabelText("Session stats").textContent ?? "";
    expect(text).toContain("LLM 2m42s");
    expect(text).not.toContain("Tool call");
  });

  it("rounds token/s: >= 10 to an integer, < 10 to one decimal", () => {
    const { rerender } = render(<ConversationStatsLine stats={stats({ decodeMs: 100_000 })} />);
    // 10000 output / 100s = 100 tok/s
    expect(screen.getByLabelText("Session stats").textContent).toContain("100 tok/s");
    rerender(<ConversationStatsLine stats={stats({ decodeMs: 100_000, tokens: { input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 5_000, total: 95_500 } })} />);
    // 500 / 100 = 5 tok/s
    expect(screen.getByLabelText("Session stats").textContent).toContain("5.0 tok/s");
  });

  it("keeps cache hit, input and output in one billing group with billed-input ratio", () => {
    render(<ConversationStatsLine stats={stats({ tokens: { input: 1000, output: 500, cacheRead: 16710, cacheWrite: 500, total: 18710 } })} />);
    const line = screen.getByLabelText("Session stats");
    // 16710/(1000+16710+500) ≈ 91.8% — never the old cacheRead/input = 1671%.
    expect(line.textContent).toBe(
      "3 turns · 4 steps | LLM 1m0s · Tool call 25.0s | TTFT avg 0.1s · 9.6 tok/s | Cache hit 92% · Input 1.0K tok · Output 500 tok",
    );
    expect(line.textContent).not.toContain("1671");
  });

  it("hides the cache part when the billed-input denominator is zero", () => {
    render(<ConversationStatsLine stats={stats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })} />);
    const text = screen.getByLabelText("Session stats").textContent ?? "";
    expect(text).not.toContain("Cache hit");
    expect(text).toContain("Input 0 tok · Output 0 tok");
  });

  it("hides timing and speed groups when the checkpoint has no timing (cold restore)", () => {
    render(<ConversationStatsLine stats={stats({ llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0 })} />);
    const text = screen.getByLabelText("Session stats").textContent ?? "";
    expect(text).not.toContain("LLM");
    expect(text).not.toContain("Tool call");
    expect(text).not.toContain("TTFT");
    expect(text).not.toContain("tok/s");
    expect(text).toBe("3 turns · 4 steps | Cache hit 42% · Input 50.0K tok · Output 10.0K tok");
  });

  it("uses the Chinese copy with the same group order and tok suffix", async () => {
    await i18n.changeLanguage("zh-Hans");
    try {
      render(<ConversationStatsLine stats={stats()} />);
      expect(screen.getByLabelText("会话统计").textContent).toBe(
        "3 轮 · 4 步 | LLM 1m0s · 工具调用 25.0s | 首 token 平均 0.1s · 192 tok/s | 缓存命中 42% · 输入 50.0K tok · 输出 10.0K tok",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("exposes the full stats line in the title attribute", () => {
    render(<ConversationStatsLine stats={stats()} />);
    expect(screen.getByLabelText("Session stats").getAttribute("title")).toBe(
      "3 turns · 4 steps | LLM 1m0s · Tool call 25.0s | TTFT avg 0.1s · 192 tok/s | Cache hit 42% · Input 50.0K tok · Output 10.0K tok",
    );
  });
});
