import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/cn";

export function MessageActions({ text, timestamp, align = "left" }: { text: string; timestamp?: string; align?: "left" | "right" }) {
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
      <button
        type="button"
        onClick={() => void copy()}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-surface-2 hover:text-text",
          align === "right" && "order-2",
        )}
        aria-label={copied ? t("conversation.copied") : t("conversation.copy")}
        title={copied ? t("conversation.copied") : t("conversation.copy")}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
      {time && (
        <time
          dateTime={timestamp}
          title={new Date(timestamp!).toLocaleString(i18n.resolvedLanguage)}
          className={cn(
            "pointer-events-none opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100",
            align === "right" && "order-1",
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
