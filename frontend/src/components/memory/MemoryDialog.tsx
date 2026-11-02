import { useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Shared responsive modal: focus is trapped/restored by Radix, body scrolls. */
export function MemoryDialog({
  title,
  close,
  children,
  footer,
  size = "default",
  scrollBody = true,
  busy = false,
  fallbackFocus,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "default" | "editor" | "wide";
  scrollBody?: boolean;
  busy?: boolean;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const recordId = useRef(
    opener.current?.closest("[data-memory-id]")?.getAttribute("data-memory-id"),
  );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          ref={panel}
          onOpenAutoFocus={(event) => {
            const field =
              panel.current?.querySelector<HTMLInputElement>("input,textarea");
            if (field) {
              event.preventDefault();
              field.focus();
            }
          }}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
            else {
              const card = recordId.current
                ? [
                    ...document.querySelectorAll<HTMLElement>(
                      "[data-memory-id]",
                    ),
                  ].find((node) => node.dataset.memoryId === recordId.current)
                : undefined;
              const target =
                card?.querySelector<HTMLButtonElement>(
                  'button[aria-haspopup="menu"]',
                ) ?? fallbackFocus?.();
              target?.focus();
            }
          }}
          style={
            {
              "--memory-dialog-width":
                size === "wide"
                  ? "1000px"
                  : size === "editor"
                    ? "760px"
                    : "720px",
            } as React.CSSProperties
          }
          className="ui-dialog fixed inset-x-0 bottom-0 z-[101] flex max-h-[90dvh] min-w-0 flex-col overflow-hidden rounded-t-2xl border border-border bg-surface-raised text-text shadow-pop outline-none sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(var(--memory-dialog-width),calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-faint px-4 py-3">
            <Dialog.Title className="min-w-0 break-words text-ui-title font-semibold">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                disabled={busy}
                aria-label={t("common.close")}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-input text-muted hover:bg-surface-hover"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <div
            className={
              scrollBody
                ? "min-h-0 min-w-0 overflow-y-auto overscroll-contain p-5"
                : "flex min-h-0 min-w-0 flex-col overflow-hidden"
            }
          >
            {children}
          </div>
          {footer && (
            <footer className="shrink-0 border-t border-faint bg-surface-raised px-5 py-4">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
