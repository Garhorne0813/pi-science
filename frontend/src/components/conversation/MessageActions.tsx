import { Check, Copy, Quote } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/ui";
import { buildMessageQuote, useActiveMessageQuote, useMessageQuoteStore, type MessageQuoteSource } from "../../lib/conversation/message-quote";

export interface MessageQuoteTarget extends MessageQuoteSource { messageText: string }
/** A live text selection inside one message, in viewport coordinates. `serial`
 *  names the selection, so re-anchoring it on scroll does not look like a new one. */
export interface MessageSelectionAnchor { text: string; serial: number; top: number; left: number }

export function MessageActions({ text, timestamp, align = "left", quote }: { text: string; timestamp?: string; align?: "left" | "right"; quote?: MessageQuoteTarget }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const activeQuote = useActiveMessageQuote();
  const armed = Boolean(quote && activeQuote?.source.blockId === quote.blockId && activeQuote.source.role === quote.role);
  const quoteMessage = () => {
    if (!quote) return;
    const { messageText, ...source } = quote;
    const built = buildMessageQuote({ source, messageText });
    if (built) useMessageQuoteStore.getState().setQuote(built);
  };
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
      {quote && <button
        type="button"
        onClick={quoteMessage}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-surface-2 hover:text-text",
          armed && "text-accent",
          align === "right" && "order-3",
        )}
        aria-label={t("conversation.quote")}
        title={armed ? t("conversation.quoted") : t("conversation.quote")}
      >
        {armed ? <Check size={11} /> : <Quote size={11} />}
      </button>}
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

export function MessageSelectionQuoteMenu({ selection, onQuote }: { selection: MessageSelectionAnchor; onQuote: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const key = selection.serial;
  // A dismissed menu stays dismissed for this selection only, so the next drag
  // brings it back without the parent having to track the dismissal. The key is
  // the selection, not its position, or scrolling would resurrect a refusal.
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setDismissed(key);
        return;
      }
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      setDismissed(key);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", dismiss, true);
    };
  }, [key]);
  if (dismissed === key) return null;
  return (
    <button
      ref={ref}
      type="button"
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onQuote}
      style={{ position: "fixed", top: selection.top, left: selection.left, transform: "translate(-50%, -100%)" }}
      className="ui-popover z-10 rounded-input px-2 py-1 text-[10px] text-text"
      aria-label={t("conversation.quoteSelection")}
    >
      {t("conversation.quoteSelection")}
    </button>
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
