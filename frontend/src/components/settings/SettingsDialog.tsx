import { lazy, Suspense, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { useRuntimeStore } from "../../lib/runtime-store";
import { useUiStore } from "../../lib/store";

/** The settings content (vertical nav + five tabs) is the heavy part; it only
 *  loads once the dialog is first opened. */
const SettingsContent = lazy(() => import("./SettingsContent").then((m) => ({ default: m.SettingsContent })));

/** Popover settings dialog (Claude-style): one instance mounted at the layout
 *  root, driven entirely by the UI store, floating above every page. */
export function SettingsDialog() {
  const { t } = useTranslation();
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const settingsScope = useUiStore((s) => s.settingsScope);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const pendingInteraction = useRuntimeStore((s) => s.pendingInteraction);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  // The conversation blocks on extension UI requests until the user responds;
  // never leave that request hidden behind the modal.
  useEffect(() => {
    if (settingsOpen && pendingInteraction) closeSettings();
  }, [settingsOpen, pendingInteraction, closeSettings]);

  useEffect(() => {
    if (settingsOpen) {
      lastFocused.current = document.activeElement as HTMLElement | null;
      panelRef.current?.focus();
    } else if (lastFocused.current) {
      lastFocused.current.focus();
      lastFocused.current = null;
    }
  }, [settingsOpen]);

  // Keep Tab inside the modal so keyboard users cannot reach the background;
  // Escape lives on the overlay so it still closes when focus escaped once.
  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    // The panel itself is the initial focus target, so Shift+Tab right after
    // opening must wrap to the last control instead of escaping the modal.
    const atEdge = (element: Element | null) => element === first || element === panelRef.current;
    if (event.shiftKey && atEdge(document.activeElement)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!settingsOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center bg-black/45 p-0 md:items-center md:p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings(); }}
      onKeyDown={(event) => { if (event.key === "Escape") closeSettings(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
        className={cn(
          "flex h-full w-full flex-col overflow-hidden bg-bg outline-none",
          "rounded-none border-0 md:h-[min(78vh,760px)] md:w-[min(880px,calc(100vw-64px))] md:rounded-card md:border md:border-border md:shadow-pop",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-faint px-5 py-3">
          <h2 id="settings-dialog-title" className="font-serif text-base text-text">
            {t("nav.settings")}
            <span className="ml-2 text-xs font-normal text-muted">
              {settingsScope ? t("settings.scope.workspace") : t("settings.scope.global")}
            </span>
          </h2>
          <button
            type="button"
            onClick={closeSettings}
            aria-label={t("common.close")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>
        <Suspense fallback={null}>
          <SettingsContent scope={settingsScope} />
        </Suspense>
      </div>
    </div>
  );
}
