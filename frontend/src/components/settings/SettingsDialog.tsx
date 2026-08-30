import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { useUiStore } from "../../lib/ui";
import { SettingsContent } from "./SettingsContent";

/** Floating settings dialog: one instance mounted at the layout root,
 *  driven entirely by the UI store, floating above every page. */
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
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:p-2 md:p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings(); }}
      onKeyDown={(event) => { if (event.key === "Escape") closeSettings(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("nav.settings")}
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
        className={cn(
          "ui-dialog flex h-full w-full overflow-hidden outline-none",
          "rounded-none border-0 shadow-none md:h-[min(86vh,860px)] md:w-[min(920px,calc(100vw-32px))] md:rounded-large md:border md:shadow-pop",
        )}
      >
        <SettingsContent scope={settingsScope} onClose={closeSettings} />
      </div>
    </div>
  );
}
