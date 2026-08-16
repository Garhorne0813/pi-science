import { useTranslation } from "react-i18next";
import type { SessionStats } from "../../lib/client/pi-science-client";

/** Whole-session cumulative stats band, rendered directly under the composer
 *  card at the same width, DeepSeek Harness StatsLine format:
 *  `12 turns · 14 steps | LLM 45.2s · Tool call 3.5s | TTFT avg 0.8s ·
 *  22 tok/s | Cache hit 61% · Input 12.2K tok · Output 517 tok`.
 *  Counters come from the durable whole-log projection (`get_session_stats`
 *  + control-plane timing), so paging, compaction and refresh never change
 *  the numbers. Hidden for a brand-new session with no turns yet. */

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

/** DeepSeek duration style: sub-minute always one decimal (`45.2s`, `0.8s`),
 *  minute-and-over as `2m42s`. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return `${minutes}m${rest}s`;
}

/** DeepSeek token/s style: >= 10 rounded to an integer, < 10 one decimal. */
function formatTokensPerSecond(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

export function ConversationStatsLine({ stats }: { stats: SessionStats | null }) {
  const { t } = useTranslation();
  if (!stats || stats.userMessages === 0) return null;

  const tokensPerSecond = stats.decodeMs && stats.decodeMs > 0
    ? stats.tokens.output / (stats.decodeMs / 1000)
    : null;
  const averageTtft = stats.ttftSteps && stats.ttftSteps > 0 && stats.ttftMs ? stats.ttftMs / stats.ttftSteps : null;
  const billedInput = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  const cacheHit = billedInput > 0 ? stats.tokens.cacheRead / billedInput : 0;

  const groups: Array<{ key: string; text: string }> = [];

  // 1. Turns · steps (whole-session counters).
  groups.push({
    key: "turns",
    text: `${stats.userMessages} ${t("conversation.stats.turns")} · ${stats.assistantMessages} ${t("conversation.stats.steps")}`,
  });

  // 2. LLM wall time · tool wall time.
  const timingParts: string[] = [];
  if ((stats.llmMs ?? 0) > 0) timingParts.push(`${t("conversation.stats.llm")} ${formatDuration(stats.llmMs ?? 0)}`);
  if ((stats.toolMs ?? 0) > 0) timingParts.push(`${t("conversation.stats.tool")} ${formatDuration(stats.toolMs ?? 0)}`);
  if (timingParts.length > 0) groups.push({ key: "time", text: timingParts.join(" · ") });

  // 3. Average TTFT · session token/s.
  const speedParts: string[] = [];
  if (averageTtft !== null) speedParts.push(`${t("conversation.stats.ttft")} ${formatDuration(averageTtft)}`);
  const tps = formatTokensPerSecond(tokensPerSecond);
  if (tps !== null) speedParts.push(`${tps} ${t("conversation.stats.tokenSpeed")}`);
  if (speedParts.length > 0) groups.push({ key: "speed", text: speedParts.join(" · ") });

  // 4. Billing: cache hit · input · output (one group, DeepSeek order).
  const billingParts: string[] = [];
  if (cacheHit > 0) billingParts.push(`${t("conversation.stats.cacheHit")} ${Math.round(cacheHit * 100)}%`);
  billingParts.push(`${t("conversation.stats.input")} ${formatTokens(stats.tokens.input)} ${t("conversation.stats.tokUnit")}`);
  billingParts.push(`${t("conversation.stats.output")} ${formatTokens(stats.tokens.output)} ${t("conversation.stats.tokUnit")}`);
  groups.push({ key: "billing", text: billingParts.join(" · ") });

  const full = groups.map((group) => group.text).join(" | ");
  return (
    <div
      className="mx-auto max-w-[var(--conversation-composer-width)] overflow-hidden whitespace-nowrap px-4 pb-1 pt-1.5 text-center text-ellipsis text-[12px] leading-[20px] text-muted"
      aria-label={t("conversation.stats.label")}
      title={full}
    >
      {full}
    </div>
  );
}
