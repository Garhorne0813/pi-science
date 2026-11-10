import { useTranslation } from "react-i18next";

export function SettingsSaveBar({ dirty, busy, saved, failed, onDiscard, onRetry }: {
  dirty: boolean;
  busy: boolean;
  saved?: boolean;
  failed?: boolean;
  onDiscard: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const status = busy ? "common.saving" : failed ? "settings.consistency.saveFailed" : dirty ? "settings.redesign.unsaved" : saved ? "settings.redesign.saved" : "memory.noChanges";
  return <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-surface-raised py-3">
    <p role="status" className="mr-auto text-ui-caption text-muted">{t(status)}</p>
    {dirty && !busy && <button type="button" onClick={onDiscard} className="min-h-10 rounded-input px-3 text-ui-label text-muted hover:bg-surface-hover">{t("common.discard")}</button>}
    {dirty && failed && !busy && onRetry && <button type="button" onClick={onRetry} className="min-h-10 rounded-input px-3 text-ui-label text-link">{t("common.retry")}</button>}
  </div>;
}
