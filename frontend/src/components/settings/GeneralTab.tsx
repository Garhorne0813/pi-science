import { useTranslation } from "react-i18next";
import { shippedLocales } from "../../i18n/config";
import { useUiStore } from "../../lib/ui";

export function GeneralTab() {
  const { t } = useTranslation();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  return (
    <section className="divide-y divide-faint border-b border-faint">
      <label className="flex min-h-14 items-center justify-between gap-panel py-2">
        <span className="text-ui-label font-medium text-text">{t("settings.appearance.label")}</span>
        <select aria-label={t("settings.appearance.label")} value={theme} onChange={(event) => setTheme(event.target.value as "light" | "dark")} className="w-auto min-w-[7rem] shrink-0 !border-0 !bg-transparent !shadow-none text-right text-sm text-text outline-none focus:border-accent">
          <option value="light">{t("settings.appearance.light")}</option>
          <option value="dark">{t("settings.appearance.dark")}</option>
        </select>
      </label>
      <label className="flex min-h-14 items-center justify-between gap-panel py-2">
        <span className="text-ui-label font-medium text-text">{t("settings.language.label")}</span>
        <select aria-label={t("settings.language.label")} value={locale} onChange={(event) => setLocale(event.target.value)} className="w-auto min-w-[7rem] shrink-0 !border-0 !bg-transparent !shadow-none text-right text-sm text-text outline-none focus:border-accent">
          {shippedLocales.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
