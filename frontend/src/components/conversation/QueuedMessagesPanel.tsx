import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Pencil, Play, RotateCcw, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "../../lib/client/pi-science-client";
import { cn } from "../../lib/ui";
import { useFeedback } from "../feedback/feedback-context";

export interface QueuedMessagesPanelProps {
  entries: QueuedMessage[];
  paused: boolean;
  onResume: () => Promise<void>;
  onEditInComposer: (entry: QueuedMessage) => Promise<void>;
  onCancel: (entryId: string) => Promise<void>;
  onRetry: (entryId: string) => Promise<void>;
  onDispatch: (entryId: string) => Promise<"accepted" | "indeterminate">;
}

/** A receipt only stays in the panel while its outcome is still open: every
 *  other receipt is already visible in the transcript, so listing it again
 *  repeats the same confirmation instead of adding information. An unconfirmed
 *  dispatch is the one exception, because "maybe not delivered" is a failure
 *  surface rather than a confirmation. */
function visibleInQueue(entry: QueuedMessage): boolean {
  if (entry.status === "queued" || entry.status === "dispatching" || entry.status === "failed") return true;
  return entry.status === "dispatched" && entry.error_code === "indeterminate";
}

const STATUS_TONE: Partial<Record<QueuedMessage["status"], string>> = {
  queued: "text-muted",
  dispatching: "text-accent",
  dispatched: "text-ok-text",
  failed: "text-error-text",
};

/** The follow-up queue as the server reports it. Only a queued entry can be
 *  edited or removed; a dispatched one already belongs to a running turn. */
export function QueuedMessagesPanel({ entries, paused, onResume, onEditInComposer, onCancel, onRetry, onDispatch }: QueuedMessagesPanelProps) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const visible = entries.filter(visibleInQueue);
  if (visible.length === 0 && !paused) return null;
  const pending = visible.filter((entry) => entry.status === "queued" || entry.status === "dispatching").length;
  const mixed = pending !== visible.length;

  const run = async (entryId: string, operation: () => Promise<void>) => {
    setBusyId(entryId);
    try { await operation(); }
    catch (error) { toast(error instanceof Error ? error.message : t("conversation.queue.updateFailed"), "error"); }
    finally { setBusyId(null); }
  };

  return (
    <section className="mb-2" aria-label={t("conversation.queue.title")}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? t("conversation.queue.collapse") : t("conversation.queue.expand")}
        onClick={() => setExpanded((current) => !current)}
        className="mb-1 flex w-full items-center gap-1 px-1 text-xs text-muted hover:text-text"
      >
        <span>{mixed ? t("conversation.queue.summaryMixed", { count: visible.length }) : t("conversation.queue.summary", { count: pending })}</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && paused && (
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
      {expanded && <ul className="flex max-h-[6.9rem] flex-col gap-1 overflow-y-auto">
        {visible.map((entry) => {
          const editable = entry.status === "queued";
          const removable = entry.status === "queued" || entry.status === "failed";
          return (
            <li key={entry.id} className="ui-card rounded-input px-3 py-2 text-xs">
              <div className="flex items-start gap-2">
                <span className={cn("shrink-0 font-medium", STATUS_TONE[entry.status])}>{t(`conversation.queue.status.${entry.status}`)}</span>
                {entry.status === "dispatched" && entry.error_code === "indeterminate" && (
                  <span className="shrink-0 text-[10px] text-warn">{t("conversation.queue.unconfirmed")}</span>
                )}
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {entry.text}
                  {entry.status === "failed" && entry.error_code && (
                    <span className="ml-1 text-[10px] text-error-text">({entry.error_code})</span>
                  )}
                </p>
                {(editable || removable) && (
                  <div className="flex shrink-0 items-center gap-1">
                    {entry.status === "queued" && (
                      <button
                        type="button"
                        aria-label={t("conversation.queue.dispatch")}
                        title={t("conversation.queue.dispatch")}
                        disabled={busyId === entry.id}
                        onClick={() => {
                          void run(entry.id, async () => {
                            const outcome = await onDispatch(entry.id);
                            if (outcome === "indeterminate")
                              toast(t("conversation.queue.indeterminate"), "info");
                          });
                        }}
                        className="text-muted hover:text-accent disabled:opacity-50"
                      >
                        <Send size={11} />
                      </button>
                    )}
                    {entry.status === "failed" && (
                      <button
                        type="button"
                        aria-label={t("conversation.queue.retry")}
                        title={t("conversation.queue.retry")}
                        disabled={busyId === entry.id}
                        onClick={() => { void run(entry.id, () => onRetry(entry.id)); }}
                        className="text-muted hover:text-accent disabled:opacity-50"
                      >
                        <RotateCcw size={11} />
                      </button>
                    )}
                    {editable && (
                      <button
                        type="button"
                        aria-label={t("conversation.queue.edit")}
                        title={t("conversation.queue.edit")}
                        onClick={() => { void onEditInComposer(entry); }}
                        className="text-muted hover:text-text"
                      >
                        <Pencil size={11} />
                      </button>
                    )}
                    {removable && (
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
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>}
    </section>
  );
}
