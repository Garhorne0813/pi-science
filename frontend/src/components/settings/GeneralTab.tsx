import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { shippedLocales } from "../../i18n/config";
import { cn, useUiStore } from "../../lib/ui";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

const THEMES = [{ value: "system", icon: Monitor }, { value: "light", icon: Sun }, { value: "dark", icon: Moon }] as const;

export function GeneralTab() {
  const { t } = useTranslation();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  const previewPaneSide = useUiStore((state) => state.previewPaneSide);
  const setPreviewPaneSide = useUiStore((state) => state.setPreviewPaneSide);
  return (
    <div className="space-y-6">
      <p className="text-ui-caption leading-relaxed text-muted">{t("settings.redesign.generalDescription")}</p>
      <section aria-labelledby="settings-appearance-title">
        <h3 id="settings-appearance-title" className="text-ui-body font-medium text-text">{t("settings.appearance.label")}</h3>
        <p className="mt-1 text-ui-caption text-muted">{t("settings.redesign.appearanceHelp")}</p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {THEMES.map(({ value, icon: ThemeIcon }) => <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)} className={cn("rounded-large border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent", theme === value ? "border-strong bg-surface-2" : "border-border bg-bg hover:bg-surface-hover")}>
            <div aria-hidden="true" className="flex h-14 overflow-hidden rounded-input border border-border bg-bg"><div className="w-9 border-r border-border bg-sidebar p-2"><div className="h-1 rounded-full bg-muted" /><div className="mt-2 h-1 rounded-full bg-surface-selected" /></div><div className="flex flex-1 items-center justify-center gap-2 bg-surface-2"><ThemeIcon size={18} className="text-muted" /></div></div>
            <span className="mt-3 flex items-center justify-between gap-2 text-ui-label text-text">{t(`settings.appearance.${value}`)}{theme === value && <Check size={14} className="text-accent" />}</span>
          </button>)}
        </div>
      </section>
      <section className="divide-y divide-faint rounded-card border border-border px-4">
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1"><h3 className="text-ui-label text-text">{t("settings.language.label")}</h3><p className="mt-1 text-ui-caption text-muted">{t("settings.redesign.languageHelp")}</p></div>
          <SettingsSelectMenu ariaLabel={t("settings.language.label")} value={locale} options={[{ value: "system", label: t("settings.language.system") }, ...shippedLocales.map((entry) => ({ value: entry.code, label: entry.label }))]} className="max-w-full" onSelect={setLocale} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1"><h3 className="text-ui-label text-text">{t("settings.layout.panelOrder.label")}</h3><p className="mt-1 text-ui-caption text-muted">{t("settings.redesign.layoutHelp")}</p></div>
          <SettingsSelectMenu ariaLabel={t("settings.layout.panelOrder.label")} value={previewPaneSide} options={[{ value: "right", label: t("settings.layout.panelOrder.conversationPreview") }, { value: "left", label: t("settings.layout.panelOrder.previewConversation") }]} className="max-w-full" onSelect={(next) => setPreviewPaneSide(next as "left" | "right")} />
        </div>
      </section>
    </div>
  );
}
