import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";

export function Modal({
  title,
  onClose,
  children,
  contentClassName,
  overlayClassName,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  contentClassName?: string;
  overlayClassName?: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = [...document.body.children]
      .filter((element) => element !== overlayRef.current)
      .map((element) => ({ element, wasInert: element.hasAttribute("inert") }));
    for (const { element } of siblings) element.setAttribute("inert", "");
    panelRef.current?.focus();
    return () => {
      for (const { element, wasInert } of siblings) {
        if (!wasInert) element.removeAttribute("inert");
      }
      lastFocusedRef.current?.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables?.length) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={overlayRef}
      className={cn("fixed inset-0 z-[115] flex items-center justify-center bg-black/40 p-4", overlayClassName)}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={handleKeyDown}
    >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cn(
            "flex max-h-[86vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-large border border-border bg-surface-raised shadow-pop outline-none",
            contentClassName,
          )}
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-faint px-5 py-3">
            <h2 id={titleId} className="text-ui-title font-medium tracking-tight text-text">{title}</h2>
            <button type="button" aria-label={t("common.close")} onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-surface-2 hover:text-text">
              <X size={16} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </div>
    </div>,
    document.body,
  );
}
