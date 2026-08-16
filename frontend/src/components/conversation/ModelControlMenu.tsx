import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AvailableModel } from "../../lib/client/pi-science-client";

const EN_THINKING_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const ZH_THINKING_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

const MENU_CONTENT_CLASS =
  "ui-popover z-[90] min-w-[220px] max-w-[min(300px,calc(100vw-16px))] rounded-card p-1.5 text-xs text-text outline-none";
const MENU_ROOT_CLASS =
  "ui-popover z-[90] min-w-[210px] max-w-[min(260px,calc(100vw-16px))] rounded-card p-1.5 text-xs text-text outline-none";
const MENU_ITEM_CLASS =
  "flex min-h-9 cursor-default select-none items-center gap-2 rounded-input px-2.5 py-2 text-xs text-text outline-none transition-colors data-[highlighted]:bg-surface-2 data-[state=open]:bg-surface-2 data-[disabled]:opacity-40";
const GROUP_HEADER_CLASS = "sticky top-0 z-10 bg-surface-raised px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted";

export function ModelControlMenu({
  models,
  selectedModel,
  thinking,
  thinkingLevels,
  contextTokens,
  contextWindow,
  contextPercent,
  compactionEnabled,
  compactionThresholdPercent,
  disabled = false,
  onModelChange,
  onThinkingChange,
}: {
  models: AvailableModel[];
  selectedModel: string;
  thinking: string;
  thinkingLevels: string[];
  contextTokens?: number | null;
  contextWindow?: number | null;
  contextPercent?: number | null;
  compactionEnabled?: boolean;
  compactionThresholdPercent?: number | null;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onThinkingChange: (level: string) => void;
}) {
  const { i18n } = useTranslation();
  const isChinese = i18n.resolvedLanguage?.startsWith("zh") ?? false;
  const [modelQuery, setModelQuery] = useState("");
  const selectedModelInfo = models.find((model) => model.id === selectedModel);
  const modelLabel = selectedModelInfo?.model || selectedModel || (isChinese ? "选择模型" : "Select model");
  const thinkingLabel = formatThinkingLabel(thinking, isChinese);
  const effectiveWindow = contextWindow || selectedModelInfo?.context_window || null;
  const contextSummary = `${formatTokens(contextTokens)} / ${formatTokens(effectiveWindow)}`;
  const labels = isChinese
    ? { model: "模型", effort: "推理强度", context: "上下文", threshold: "自动压缩阈值", trigger: "选择模型、推理强度并查看上下文", searchPlaceholder: "搜索模型", searchEmpty: "无匹配模型" }
    : { model: "Model", effort: "Effort", context: "Context", threshold: "Auto-compaction threshold", trigger: "Select model and thinking level and view context", searchPlaceholder: "Search models", searchEmpty: "No matching models" };
  // Warn shortly before Pi's auto-compaction kicks in (within 10% of the threshold).
  const nearCompaction = Boolean(compactionEnabled) && compactionThresholdPercent != null && contextPercent != null
    && contextPercent >= compactionThresholdPercent - 10;
  const ringPercent = Math.min(100, Math.max(0, contextPercent ?? 0));
  const roundedContextPercent = Math.round(contextPercent ?? 0);
  const contextRingLabel = `${labels.context}: ${contextSummary} · ${roundedContextPercent}%${nearCompaction ? ` · ${labels.threshold}: ${compactionThresholdPercent}%` : ""}`;

  // Model list: filter by query, then group by provider preserving first-seen order.
  const normalizedQuery = modelQuery.trim().toLowerCase();
  const visibleModels = normalizedQuery
    ? models.filter((model) =>
        model.id.toLowerCase().includes(normalizedQuery)
        || model.model.toLowerCase().includes(normalizedQuery)
        || model.label.toLowerCase().includes(normalizedQuery),
      )
    : models;
  const groups: Array<{ provider: string; models: AvailableModel[] }> = [];
  for (const model of visibleModels) {
    const group = groups.find((item) => item.provider === model.provider);
    if (group) group.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }

  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (!open) setModelQuery(""); }}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={labels.trigger}
          className="group flex h-7 min-h-0 min-w-0 max-w-[420px] items-center gap-2 rounded-input px-2.5 text-left text-xs text-text outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate">{modelLabel}</span>
            <span className="shrink-0 text-muted">{thinkingLabel}</span>
            {contextPercent != null && (
              <span
                role="img"
                aria-label={contextRingLabel}
                title={contextRingLabel}
                className="ml-1 shrink-0"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90" fill="none">
                  <circle cx="8" cy="8" r="5.5" stroke="var(--border)" strokeWidth="2" />
                  <circle
                    cx="8"
                    cy="8"
                    r="5.5"
                    pathLength="100"
                    stroke={nearCompaction ? "var(--warn)" : "var(--accent)"}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={`${ringPercent} 100`}
                  />
                </svg>
              </span>
            )}
          </span>
          <ChevronDown size={13} className="shrink-0 text-muted transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          sideOffset={8}
          collisionPadding={8}
          className={MENU_ROOT_CLASS}
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS}>
              <span className="font-medium">{labels.model}</span>
              <span className="ml-auto max-w-[120px] truncate text-muted">{modelLabel}</span>
              <ChevronRight size={13} className="shrink-0 text-muted" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={4} alignOffset={-6} collisionPadding={8} className={MENU_CONTENT_CLASS}>
                <div className="mb-1.5 border-b border-faint pb-1.5">
                  <div className="flex h-8 items-center gap-1.5 rounded-input bg-surface-2 px-2">
                    <Search size={12} className="shrink-0 text-muted" />
                    <input
                      type="text"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      placeholder={labels.searchPlaceholder}
                      aria-label={labels.searchPlaceholder}
                      className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
                      onKeyDown={(event) => {
                        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
                      }}
                    />
                  </div>
                </div>
                <div className="max-h-[min(320px,calc(100vh-120px))] overflow-y-auto overscroll-contain">
                  {groups.length === 0 && <p className="px-2.5 py-4 text-center text-[11px] text-muted">{labels.searchEmpty}</p>}
                  <DropdownMenu.RadioGroup value={selectedModel}>
                  {groups.map((group) => (
                    <div key={group.provider} role="group" aria-label={group.provider}>
                      <div className={GROUP_HEADER_CLASS}>{group.provider}</div>
                      {group.models.map((model) => (
                        <DropdownMenu.RadioItem
                          key={model.id}
                          value={model.id}
                          onSelect={() => onModelChange(model.id)}
                          className={MENU_ITEM_CLASS}
                        >
                          <span className="min-w-0 flex-1 truncate">{model.model}</span>
                          <DropdownMenu.ItemIndicator>
                            <Check size={14} className="shrink-0 text-accent" />
                          </DropdownMenu.ItemIndicator>
                        </DropdownMenu.RadioItem>
                      ))}
                    </div>
                  ))}
                  </DropdownMenu.RadioGroup>
                </div>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger disabled={!selectedModel || thinkingLevels.length === 0} className={MENU_ITEM_CLASS}>
              <span className="font-medium">{labels.effort}</span>
              <span className="ml-auto text-muted">{thinkingLabel}</span>
              <ChevronRight size={13} className="shrink-0 text-muted" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={4} alignOffset={-6} collisionPadding={8} className={MENU_CONTENT_CLASS}>
                <div className="max-h-[min(320px,calc(100vh-120px))] overflow-y-auto overscroll-contain">
                  <DropdownMenu.RadioGroup value={thinking}>
                  {thinkingLevels.map((level) => (
                    <DropdownMenu.RadioItem
                      key={level}
                      value={level}
                      onSelect={() => onThinkingChange(level)}
                      className={MENU_ITEM_CLASS}
                    >
                      <span className="min-w-0 flex-1 truncate">{formatThinkingLabel(level, isChinese)}</span>
                      <DropdownMenu.ItemIndicator>
                        <Check size={14} className="shrink-0 text-accent" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                  </DropdownMenu.RadioGroup>
                </div>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function formatTokens(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function formatThinkingLabel(level: string, isChinese: boolean) {
  const labels = isChinese ? ZH_THINKING_LABELS : EN_THINKING_LABELS;
  return labels[level] || level;
}
