/** The Settings preview and Agent Core must use the same compaction policy. */
export function resolveAgentCompaction(contextWindow: number, settings: { compaction_enabled?: boolean; compaction_threshold_percent?: number } = {}) {
  const thresholdPercent = settings.compaction_threshold_percent
    ?? (contextWindow > 16384 ? Math.min(95, Math.max(50, Math.round((1 - 16384 / contextWindow) * 100))) : 85);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isFinite(thresholdPercent) || thresholdPercent < 50 || thresholdPercent > 95) throw new Error("invalid model window or compaction threshold");
  const reserveTokens = Math.ceil(contextWindow * (100 - thresholdPercent) / 100);
  return { thresholdPercent, compaction: { enabled: settings.compaction_enabled !== false, reserveTokens, keepRecentTokens: 20000 }, compactionPointTokens: contextWindow - reserveTokens };
}
