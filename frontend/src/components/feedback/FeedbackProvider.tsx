import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { FeedbackContext, type ConfirmOptions, type ToastTone } from "./feedback-context";

type Toast = { id: number; message: string; tone: ToastTone };

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const nextId = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmation, setConfirmation] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);

  const toast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = ++nextId.current;
    setToasts((current) => [...current, { id, message, tone }]);
    globalThis.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3500);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    // Capture the trigger synchronously: the confirm dialog autoFocuses its
    // cancel button on render, which would otherwise become the recorded
    // activeElement and be gone by the time we restore focus.
    lastFocused.current = document.activeElement as HTMLElement | null;
    setConfirmation({ ...options, resolve });
  }), []);

  const finishConfirmation = (value: boolean) => {
    confirmation?.resolve(value);
    setConfirmation(null);
  };

  // Restore focus to the element that opened the confirm dialog, so keyboard
  // users do not end up on <body> (where the settings modal Escape/Tab handlers
  // would no longer fire) after cancelling.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!confirmation && lastFocused.current) {
      lastFocused.current.focus();
      lastFocused.current = null;
    }
  }, [confirmation]);

  // Escape cancels the confirm dialog (replacing window.confirm behaviour that
  // the SubagentSettings flow used to rely on).
  useEffect(() => {
    if (!confirmation) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        confirmation.resolve(false);
        setConfirmation(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmation]);

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
        {toasts.map((item) => {
          const Icon = item.tone === "success" ? CheckCircle2 : item.tone === "error" ? XCircle : Info;
          return (
            <div key={item.id} className={cn("ui-popover pointer-events-auto flex items-start gap-2 rounded-input px-3 py-2.5 text-sm", item.tone === "error" ? "border-error/30 text-error" : item.tone === "success" ? "border-ok/30 text-ok" : "text-text")}>
              <Icon size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 leading-5">{item.message}</span>
              <button type="button" aria-label={t("common.close")} onClick={() => setToasts((current) => current.filter((toastItem) => toastItem.id !== item.id))} className="text-muted hover:text-text"><X size={14} /></button>
            </div>
          );
        })}
      </div>
      {confirmation && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finishConfirmation(false); }}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description" className="ui-dialog w-full max-w-sm rounded-card p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className={cn("mt-0.5 shrink-0", confirmation.destructive ? "text-error" : "text-warn")} />
              <div>
                <h2 id="confirm-title" className="font-medium text-text">{confirmation.title}</h2>
                <p id="confirm-description" className="mt-1.5 text-sm leading-6 text-muted">{confirmation.message}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => finishConfirmation(false)} className="h-9 rounded-input border border-border px-3 text-sm text-muted hover:text-text">{t("common.cancel")}</button>
              <button type="button" onClick={() => finishConfirmation(true)} className={cn("h-9 rounded-input px-3 text-sm font-medium", confirmation.destructive ? "bg-error text-white" : "bg-accent text-accent-fg")}>{confirmation.confirmLabel || t("common.ok")}</button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}
