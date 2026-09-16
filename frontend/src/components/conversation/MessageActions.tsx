import { Check, ChevronLeft, ChevronRight, Copy, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/ui";

export function MessageActions({ text, timestamp, align = "left", disabled = false, onRegenerate, onEdit, version }: {
  text: string;
  timestamp?: string;
  align?: "left" | "right";
  disabled?: boolean;
  onRegenerate?: () => void;
  onEdit?: () => void;
  version?: {
    index: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
  };
}) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 1600);
  };
  const time = timestamp ? formatMessageTime(timestamp, i18n.resolvedLanguage) : "";

  return (
    <div className={cn("flex min-h-6 items-center gap-1.5 text-[10px] text-muted/70", align === "right" && "justify-end")}>
      {onEdit && (
        <button
          type="button"
          disabled={disabled}
          onClick={onEdit}
          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
          aria-label={t("conversation.edit")}
          title={t("conversation.edit")}
        >
          <Pencil size={11} />
        </button>
      )}
      {onRegenerate && (
        <button
          type="button"
          disabled={disabled}
          onClick={onRegenerate}
          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-40"
          aria-label={t("conversation.regenerate")}
          title={t("conversation.regenerate")}
        >
          <RotateCcw size={11} />
        </button>
      )}
      <button
        type="button"
        onClick={() => void copy()}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-surface-2 hover:text-text",
        )}
        aria-label={copied ? t("conversation.copied") : t("conversation.copy")}
        title={copied ? t("conversation.copied") : t("conversation.copy")}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
      {version && version.total > 1 && (
        <div className="flex h-6 items-center rounded border border-border/70 bg-surface" aria-label={t("conversation.responseVersions")}>
          <button
            type="button"
            disabled={disabled || version.index <= 0}
            onClick={version.onPrevious}
            className="flex h-6 w-6 items-center justify-center rounded-l transition-colors hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-35"
            aria-label={t("conversation.previousResponseVersion")}
            title={t("conversation.previousResponseVersion")}
          >
            <ChevronLeft size={11} />
          </button>
          <span className="min-w-9 px-1 text-center text-[10px] tabular-nums text-muted" aria-live="polite">
            {version.index + 1}/{version.total}
          </span>
          <button
            type="button"
            disabled={disabled || version.index >= version.total - 1}
            onClick={version.onNext}
            className="flex h-6 w-6 items-center justify-center rounded-r transition-colors hover:bg-surface-2 hover:text-text disabled:pointer-events-none disabled:opacity-35"
            aria-label={t("conversation.nextResponseVersion")}
            title={t("conversation.nextResponseVersion")}
          >
            <ChevronRight size={11} />
          </button>
        </div>
      )}
      {time && (
        <time
          dateTime={timestamp}
          title={new Date(timestamp!).toLocaleString(i18n.resolvedLanguage)}
          className={cn(
            "pointer-events-none opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100",
            align === "right" && "order-first",
          )}
        >
          {time}
        </time>
      )}
    </div>
  );
}

function formatMessageTime(value: string, locale?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}
