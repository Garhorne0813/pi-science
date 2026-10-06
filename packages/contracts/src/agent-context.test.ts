import { describe, expect, it } from "vitest";
import { resolveAgentCompaction } from "./agent-context.js";

describe("shared Agent Core compaction policy", () => {
  it("shows the same trigger and reserve that the runtime receives, including rounding", () => {
    expect(resolveAgentCompaction(100000, { compaction_threshold_percent: 80 })).toEqual({ thresholdPercent: 80, compactionPointTokens: 80000, compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 20000 } });
    expect(resolveAgentCompaction(4096)).toMatchObject({ compactionPointTokens: 3481, compaction: { reserveTokens: 615 } });
    expect(resolveAgentCompaction(128000, { compaction_threshold_percent: 95 })).toMatchObject({ compactionPointTokens: 121600, compaction: { reserveTokens: 6400 } });
  });
  it("preserves disabled compaction and validates the accepted threshold range", () => {
    expect(resolveAgentCompaction(1000000, { compaction_enabled: false })).toMatchObject({ thresholdPercent: 95, compaction: { enabled: false, reserveTokens: 50000 } });
    for (const window of [0, -1, Infinity, 1.5]) expect(() => resolveAgentCompaction(window)).toThrow();
    for (const threshold of [49, 96, NaN]) expect(() => resolveAgentCompaction(128000, { compaction_threshold_percent: threshold })).toThrow();
  });
});
