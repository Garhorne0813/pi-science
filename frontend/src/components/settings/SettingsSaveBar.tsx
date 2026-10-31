import { useTranslation } from "react-i18next";
export function SettingsSaveBar({ dirty, busy, onDiscard, onSave, label, saved = false }: { dirty: boolean; busy: boolean; onDiscard: () => void; onSave?: () => void; label?: string; saved?: boolean }) {
  const { t } = useTranslation();
  return <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-surface-raised py-3">
    <p role="status" className="mr-auto text-ui-caption text-muted">{t(busy ? "common.saving" : saved ? "settings.redesign.saved" : dirty ? "settings.redesign.unsaved" : "memory.noChanges")}</p>
    {dirty && <button type="button" disabled={busy} onClick={onDiscard} className="min-h-9 rounded-input px-3 text-ui-label text-muted hover:bg-surface-hover disabled:opacity-40">{t("common.discard")}</button>}
    <button type={onSave ? "button" : "submit"} disabled={busy || !dirty} onClick={onSave} className="min-h-9 rounded-input bg-accent-fill px-3 text-ui-label font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40">{busy ? t("common.saving") : label ?? t("common.save")}</button>
  </div>;
}
