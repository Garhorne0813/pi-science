import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronRight, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/ui";
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

const MENU_CONTENT_CLASS = "z-[90] min-w-[180px] max-w-[min(300px,calc(100vw-16px))] overflow-y-auto rounded-card border border-border bg-surface p-1.5 text-xs text-text shadow-pop outline-none";
const MENU_ITEM_CLASS = "flex min-h-9 cursor-default select-none items-center gap-2 rounded-input px-2.5 py-2 text-xs text-text outline-none transition-colors data-[highlighted]:bg-surface-2 data-[state=open]:bg-surface-2 data-[disabled]:opacity-40";

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
  const selectedModelInfo = models.find((model) => model.id === selectedModel);
  const modelLabel = selectedModelInfo?.model || selectedModel || (isChinese ? "选择模型" : "Select model");
  const thinkingLabel = formatThinkingLabel(thinking, isChinese);
  const effectiveWindow = contextWindow || selectedModelInfo?.context_window || null;
  const contextSummary = `${formatTokens(contextTokens)} / ${formatTokens(effectiveWindow)}`;
  const labels = isChinese
    ? { model: "模型", thinking: "推理强度", context: "上下文", threshold: "自动压缩阈值", trigger: "选择模型、推理强度并查看上下文" }
    : { model: "Model", thinking: "Thinking", context: "Context", threshold: "Auto-compaction threshold", trigger: "Select model and thinking level and view context" };
  // Warn shortly before Pi's auto-compaction kicks in (within 10% of the threshold).
  const nearCompaction = Boolean(compactionEnabled) && compactionThresholdPercent != null && contextPercent != null
    && contextPercent >= compactionThresholdPercent - 10;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={labels.trigger}
          className="group flex min-h-9 min-w-0 max-w-[420px] items-center gap-2 rounded-input px-2.5 py-1 text-left text-xs text-text outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate">{modelLabel}</span>
            <span className="shrink-0 text-muted">{thinkingLabel}</span>
            {contextPercent != null && (
              <span
                title={nearCompaction ? `${labels.threshold}: ${compactionThresholdPercent}%` : undefined}
                className={cn("ml-1 flex shrink-0 items-center gap-1 border-l border-faint pl-2 font-mono text-[10px]", nearCompaction ? "text-warn" : "text-muted")}
              >
                <Gauge size={10} />
                {formatTokens(contextTokens)}/{formatTokens(effectiveWindow)} · {Math.round(contextPercent)}%{nearCompaction ? ` → ${compactionThresholdPercent}%` : ""}
              </span>
            )}
          </span>
          <ChevronDown size={13} className="shrink-0 text-muted transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className={MENU_CONTENT_CLASS}
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS}>
              <span className="font-medium">{labels.model}</span>
              <span className="ml-auto max-w-[120px] truncate text-muted">{modelLabel}</span>
              <ChevronRight size={13} className="shrink-0 text-muted" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={4} alignOffset={-6} collisionPadding={8} className={MENU_CONTENT_CLASS}>
                {models.map((model) => (
                  <DropdownMenu.Item
                    key={model.id}
                    onSelect={() => onModelChange(model.id)}
                    className={MENU_ITEM_CLASS}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.model}</span>
                    {model.id === selectedModel && <Check size={14} className="shrink-0 text-accent" />}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger disabled={!selectedModel || thinkingLevels.length === 0} className={MENU_ITEM_CLASS}>
              <span className="font-medium">{labels.thinking}</span>
              <span className="ml-auto text-muted">{thinkingLabel}</span>
              <ChevronRight size={13} className="shrink-0 text-muted" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={4} alignOffset={-6} collisionPadding={8} className={MENU_CONTENT_CLASS}>
                {thinkingLevels.map((level) => (
                  <DropdownMenu.Item
                    key={level}
                    onSelect={() => onThinkingChange(level)}
                    className={MENU_ITEM_CLASS}
                  >
                    <span className="min-w-0 flex-1 truncate">{formatThinkingLabel(level, isChinese)}</span>
                    {level === thinking && <Check size={14} className="shrink-0 text-accent" />}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Separator className="my-1 h-px bg-faint" />
          <div className="space-y-1 px-2.5 py-2 text-[11px] text-muted">
            <div className="flex items-center justify-between gap-3"><span>{labels.context}</span><span className="font-mono text-text">{contextSummary}{contextPercent != null ? ` · ${Math.round(contextPercent)}%` : ""}</span></div>
            <div className="flex items-center justify-between gap-3"><span>{labels.threshold}</span><span className="font-mono text-text">{compactionEnabled === false ? (isChinese ? "关闭" : "Off") : compactionThresholdPercent != null ? `${compactionThresholdPercent}%` : (isChinese ? "Pi 默认" : "Pi default")}</span></div>
          </div>
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
