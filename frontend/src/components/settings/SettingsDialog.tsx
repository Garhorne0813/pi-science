import { lazy, Suspense, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { useUiStore } from "../../lib/ui";
import { IconButton } from "../ui/Icon";

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
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/65 p-0 backdrop-blur-[2px] sm:p-2 md:p-4"
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
          "rounded-none border-0 shadow-none md:h-[min(80vh,820px)] md:w-[min(760px,calc(100vw-32px))] md:rounded-[16px] md:border md:shadow-pop",
        )}
      >
        <Suspense fallback={(
          <div className="flex min-h-0 flex-1">
            <div className="flex w-16 shrink-0 items-start justify-center border-r border-faint bg-surface-2/20 px-2 py-panel md:w-44 md:justify-start md:px-3 md:py-4">
              <IconButton
                icon={X}
                label={t("common.close")}
                size="touch"
                onClick={closeSettings}
                className="bg-surface-2/70"
              />
            </div>
            <div className="flex flex-1 items-center justify-center text-sm text-muted">{t("common.loading")}</div>
          </div>
        )}>
          <SettingsContent scope={settingsScope} onClose={closeSettings} />
        </Suspense>
      </div>
    </div>
  );
}
