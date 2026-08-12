import { Bookmark, Check, Loader2, Sparkles, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import type { ConversationBookmark } from "../../lib/conversation-navigation";

export function ConversationBookmarksPanel({
  id,
  bookmarks,
  loading,
  open,
  onClose,
  onJump,
  onAccept,
  onReject,
  onDelete,
  onSuggest,
  suggesting,
}: {
  id?: string;
  bookmarks: ConversationBookmark[];
  loading: boolean;
  open: boolean;
  onClose: () => void;
  /** Jump to the persisted message (loads older pages when needed). */
  onJump: (messageId: string) => void;
  onAccept: (bookmarkId: string) => void;
  onReject: (bookmarkId: string) => void;
  onDelete: (bookmarkId: string) => void;
  onSuggest: () => void;
  suggesting: boolean;
}) {
  const { t } = useTranslation();
  // Non-modal popover: Escape closes it and hands focus back to the trigger
  // (the page's `closeBookmarks` refocuses the header button).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
  if (!open) return null;

  return (
    <div
      id={id}
      role="region"
      aria-label={t("conversation.bookmarks")}
      className="ui-popover absolute right-0 top-full z-30 mt-1 flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-card shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-faint px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text">
          <Bookmark size={12} className="text-accent" />
          {t("conversation.bookmarks")}
          {bookmarks.length > 0 && <span className="text-muted">({bookmarks.length})</span>}
        </span>
        <button
          type="button"
          aria-label={t("conversation.closeBookmarks")}
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted" role="status">
            <Loader2 size={13} className="animate-spin text-accent" />
            {t("conversation.bookmarksLoading")}
          </div>
        ) : bookmarks.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs italic text-muted/70">{t("conversation.bookmarksEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {bookmarks.map((bookmark) => (
              <li key={bookmark.bookmark_id} className="group flex items-start gap-1 rounded-input px-2 py-1.5 hover:bg-surface-2">
                <button
                  type="button"
                  onClick={() => onJump(bookmark.message_id)}
                  className="min-w-0 flex-1 text-left"
                  aria-label={`${bookmark.label ?? bookmark.quote.slice(0, 80)} — ${t("conversation.bookmarkJump")}`}
                >
                  <span className="block truncate text-xs text-text">{bookmark.label ?? bookmark.quote}</span>
                  <span className="block truncate text-[10px] text-muted">
                    {bookmark.quote.length > 80 ? `${bookmark.quote.slice(0, 80)}…` : bookmark.quote}
                  </span>
                  {bookmark.status === "proposed" && (
                    <span className="mt-0.5 inline-block rounded-full bg-warn/15 px-1.5 py-px text-[9px] text-warn">
                      {t("conversation.bookmarkProposed")}
                    </span>
                  )}
                </button>
                {bookmark.status === "proposed" ? (
                  <>
                    <button
                      type="button"
                      aria-label={t("conversation.bookmarkAccept")}
                      title={t("conversation.bookmarkAccept")}
                      onClick={() => onAccept(bookmark.bookmark_id)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-ok/15 hover:text-ok"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("conversation.bookmarkReject")}
                      title={t("conversation.bookmarkReject")}
                      onClick={() => onReject(bookmark.bookmark_id)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-error/15 hover:text-error"
                    >
                      <X size={12} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    aria-label={t("conversation.bookmarkRemove")}
                    title={t("conversation.bookmarkRemove")}
                    onClick={() => onDelete(bookmark.bookmark_id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-error/15 hover:text-error"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-faint px-2 py-1.5">
        <button
          type="button"
          onClick={onSuggest}
          disabled={suggesting}
          className={cn(
            "flex h-7 w-full items-center justify-center gap-1.5 rounded-input px-2 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text",
            suggesting && "cursor-wait opacity-60",
          )}
        >
          {suggesting ? <Loader2 size={12} className="animate-spin text-accent" /> : <Sparkles size={12} className="text-accent" />}
          {t("conversation.bookmarkSuggest")}
        </button>
      </div>
    </div>
  );
}
