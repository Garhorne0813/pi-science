import { useState } from "react";
import { Check, Loader2, Pencil, Play, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "../../lib/client/pi-science-client";
import { cn } from "../../lib/ui";
import { useFeedback } from "../feedback/feedback-context";

export interface QueuedMessagesPanelProps {
  entries: QueuedMessage[];
  paused: boolean;
  onResume: () => Promise<void>;
  onEdit: (entryId: string, text: string) => Promise<void>;
  onCancel: (entryId: string) => Promise<void>;
  onDispatch: (entryId: string) => Promise<void>;
}

const STATUS_TONE: Record<QueuedMessage["status"], string> = {
  queued: "text-muted",
  dispatching: "text-accent",
  dispatched: "text-ok-text",
  failed: "text-error-text",
  cancelled: "text-muted line-through",
};

/** The follow-up queue as the server reports it. Only a queued entry can be
 *  edited or removed; a dispatched one already belongs to a running turn. */
export function QueuedMessagesPanel({ entries, paused, onResume, onEdit, onCancel, onDispatch }: QueuedMessagesPanelProps) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  if (entries.length === 0 && !paused) return null;

  const run = async (entryId: string, operation: () => Promise<void>) => {
    setBusyId(entryId);
    try { await operation(); }
    catch (error) { toast(error instanceof Error ? error.message : t("conversation.queue.updateFailed"), "error"); }
    finally { setBusyId(null); }
  };

  return (
    <section className="mb-2" aria-label={t("conversation.queue.title")}>
      {paused && (
        <div role="status" className="mb-2 flex items-center gap-2 rounded-input border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-muted">
          <span>{t("conversation.queue.paused")}</span>
          <button
            type="button"
            onClick={() => { void run("resume", onResume); }}
            disabled={busyId !== null}
            className="flex items-center gap-1 text-accent hover:underline disabled:opacity-50"
          >
            <Play size={11} />
            {t("conversation.queue.resume")}
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => {
          const editable = entry.status === "queued" || entry.status === "failed";
          const editing = editingId === entry.id;
          return (
            <li key={entry.id} className="ui-card rounded-input px-3 py-2 text-xs">
              <div className="flex items-start gap-2">
                <span className={cn("shrink-0 font-medium", STATUS_TONE[entry.status])}>{t(`conversation.queue.status.${entry.status}`)}</span>
                {editing ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label={t("conversation.queue.editLabel")}
                      rows={2}
                      className="w-full resize-y rounded-input bg-surface-2 px-2 py-1 text-xs text-text outline-none"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!draft.trim() || busyId === entry.id}
                        onClick={() => { void run(entry.id, async () => { await onEdit(entry.id, draft.trim()); setEditingId(null); }); }}
                        className="flex items-center gap-1 text-accent hover:underline disabled:opacity-50"
                      >
                        <Check size={11} />
                        {t("conversation.queue.save")}
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="flex items-center gap-1 text-muted hover:underline">
                        <X size={11} />
                        {t("conversation.queue.cancelEdit")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", entry.status === "cancelled" && "text-muted line-through")}>
                      {entry.text}
                      {entry.status === "failed" && entry.error_code && (
                        <span className="ml-1 text-[10px] text-error-text">({entry.error_code})</span>
                      )}
                    </p>
                    {editable && (
                      <div className="flex shrink-0 items-center gap-1">
                        {entry.status === "queued" && (
                          <button
                            type="button"
                            aria-label={t("conversation.queue.dispatch")}
                            title={t("conversation.queue.dispatch")}
                            disabled={busyId === entry.id}
                            onClick={() => { void run(entry.id, () => onDispatch(entry.id)); }}
                            className="text-muted hover:text-accent disabled:opacity-50"
                          >
                            <Send size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={t("conversation.queue.edit")}
                          title={t("conversation.queue.edit")}
                          onClick={() => { setEditingId(entry.id); setDraft(entry.text); }}
                          className="text-muted hover:text-text"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          type="button"
                          aria-label={t("conversation.queue.remove")}
                          title={t("conversation.queue.remove")}
                          disabled={busyId === entry.id}
                          onClick={() => { void run(entry.id, () => onCancel(entry.id)); }}
                          className="text-muted hover:text-error-text disabled:opacity-50"
                        >
                          {busyId === entry.id ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
