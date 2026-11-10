import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { messageAnchorId } from "../../lib/conversation/quoted-message";
import type { MessageQuote } from "../../lib/conversation/message-quote";

/** Above this, the collapsed card cannot show the whole quote, so it offers to
 *  expand. The stored text is always complete; only the preview is clipped. */
const PREVIEW_LIMIT = 120;

/** The pending quote above the composer input. It shows which message the user
 *  quoted, the quoted text, and the two actions that matter: go back to the
 *  source, or drop the quote. */
export function MessageQuoteCard({ quote, onRemove }: { quote: MessageQuote; onRemove: () => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [missing, setMissing] = useState(false);
  const anchor = messageAnchorId(quote.source);
  const foldable = quote.text.length > PREVIEW_LIMIT || quote.text.includes("\n");
  const hasFullMessage = quote.kind === "selection" && quote.messageText !== quote.text;

  // A new quote starts folded and without the previous quote's missing-source
  // notice, which described a message this card no longer refers to.
  useEffect(() => { setExpanded(false); setMissing(false); }, [anchor, quote.text]);

  const locate = () => {
    const target = typeof document === "undefined" ? null : document.getElementById(anchor);
    // History paging and virtualisation unmount old messages, and a deleted
    // message never returns. Say so instead of doing nothing on the click.
    if (!target) { setMissing(true); return; }
    setMissing(false);
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="border-b border-faint px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={locate}
              className="flex items-center gap-1 rounded-input bg-accent/5 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-accent/20 hover:bg-accent/10"
              aria-label={t("conversation.quoteCardLocate")}
              title={t("conversation.quoteCardLocate")}
            >
              {quote.source.role === "user" ? t("conversation.quoteCardFromUser") : t("conversation.quoteCardFromAgent")}
            </button>
            <span className="text-[10px] text-muted">
              {quote.kind === "selection" ? t("conversation.quoteCardSelection") : t("conversation.quoteCardMessage")}
            </span>
            {foldable && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="flex items-center gap-0.5 text-[10px] text-muted hover:text-text"
                aria-expanded={expanded}
              >
                {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                {expanded ? t("conversation.quoteCardCollapse") : t("conversation.quoteCardExpand")}
              </button>
            )}
          </div>
          <div className={cn("mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-text", !expanded && "line-clamp-2")}>
            {quote.text}
          </div>
          {expanded && hasFullMessage && (
            <div className="mt-1 border-t border-faint pt-1">
              <div className="text-[10px] text-muted">{t("conversation.quoteCardFullMessage")}</div>
              <div className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted">{quote.messageText}</div>
            </div>
          )}
          {missing && <div role="status" className="mt-1 text-[10px] text-muted">{t("conversation.quoteCardMissing")}</div>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("conversation.quoteCardRemove")}
          title={t("conversation.quoteCardRemove")}
          className="shrink-0 text-muted hover:text-error-text"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
