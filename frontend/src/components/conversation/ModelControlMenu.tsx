import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AvailableModel } from "../../lib/pi-science-client";

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
  disabled = false,
  onModelChange,
  onThinkingChange,
}: {
  models: AvailableModel[];
  selectedModel: string;
  thinking: string;
  thinkingLevels: string[];
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onThinkingChange: (level: string) => void;
}) {
  const { i18n } = useTranslation();
  const isChinese = i18n.resolvedLanguage?.startsWith("zh") ?? false;
  const selectedModelInfo = models.find((model) => model.id === selectedModel);
  const modelLabel = selectedModelInfo?.model || selectedModel || (isChinese ? "选择模型" : "Select model");
  const thinkingLabel = formatThinkingLabel(thinking, isChinese);
  const labels = isChinese
    ? { model: "模型", thinking: "推理强度", trigger: "选择模型和推理强度" }
    : { model: "Model", thinking: "Thinking", trigger: "Select model and thinking level" };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={labels.trigger}
          className="group flex min-h-7 min-w-0 max-w-[260px] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-text outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="min-w-0 truncate">{modelLabel}</span>
          {selectedModel && thinkingLevels.length > 0 && (
            <span className="shrink-0 text-muted">{thinkingLabel}</span>
          )}
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function formatThinkingLabel(level: string, isChinese: boolean) {
  const labels = isChinese ? ZH_THINKING_LABELS : EN_THINKING_LABELS;
  return labels[level] || level;
}
