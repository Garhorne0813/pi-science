import { describe, expect, it } from "vitest";
import { shouldCompact, type Entry } from "@earendil-works/pi-agent-core";
import { contextUsage, resolveCompaction, resolveContextWindow } from "./agent-runtime-settings.js";

const entry = (value: Record<string, unknown>) => value as unknown as Entry;
const assistant = (tokens: number) => entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }],
  stopReason: "stop", usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens }, timestamp: 1 } });

describe("agent-core context and compaction facts", () => {
  it("applies both explicit and displayed default thresholds to the upstream engine", () => {
    const explicit = resolveCompaction(100000, { compaction_threshold_percent: 80 });
    expect(explicit.compaction.reserveTokens).toBe(20000);
    expect(shouldCompact(80000, 100000, explicit.compaction)).toBe(false);
    expect(shouldCompact(80001, 100000, explicit.compaction)).toBe(true);
    const defaults = resolveCompaction(1000000);
    expect(defaults.thresholdPercent).toBe(95);
    expect(defaults.compaction.reserveTokens).toBe(50000);
    expect(shouldCompact(999999, 1000000, resolveCompaction(1000000, { compaction_enabled: false }).compaction)).toBe(false);
    expect(resolveCompaction(4096).compaction).toMatchObject({ keepRecentTokens: 20000, reserveTokens: 615 });
  });

  it("binds explicit window overrides to one model and ignores old cache values", () => {
    const settings = { model_context_window: 123456, model_context_window_override: { model: "lab/one", context_window: 8192 } };
    expect(resolveContextWindow("lab/one", 128000, settings)).toBe(8192);
    expect(resolveContextWindow("lab/two", 128000, settings)).toBe(128000);
  });

  it("uses current context usage rather than accumulated session totals or compacted usage", async () => {
    expect(await contextUsage([], 100000)).toEqual({ context_tokens: null, context_window: 100000, context_percent: null });
    expect(await contextUsage([assistant(90000), assistant(20000)], 100000)).toMatchObject({ context_tokens: 20000, context_percent: 20 });
    const compacted = entry({ type: "compaction", summary: "Prior work", tokensBefore: 90000, retainedTail: [assistant(90000).type === "message" ? (assistant(90000) as Extract<Entry, { type: "message" }>).message : null], timestamp: 1 });
    expect(await contextUsage([assistant(90000), compacted], 100000)).toMatchObject({ context_tokens: null });
    expect(await contextUsage([assistant(90000), compacted, assistant(1000)], 100000)).toMatchObject({ context_tokens: 1000, context_percent: 1 });
    expect(await contextUsage([assistant(1000), entry({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "a".repeat(400) }] } })], 100000))
      .toMatchObject({ context_tokens: 1100 });
  });
});
