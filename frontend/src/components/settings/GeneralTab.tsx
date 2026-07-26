import { useTranslation } from "react-i18next";
import { shippedLocales } from "../../i18n/config";
import { useUiStore } from "../../lib/store";
import { Section } from "./Section";

export function GeneralTab() {
  const { t } = useTranslation();
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  return (
    <div className="space-y-6">
      <Section title={t("settings.language.title")}>
        <p className="mb-3 text-[11px] text-muted">{t("settings.language.description")}</p>
        <select aria-label={t("settings.language.label")} value={locale} onChange={(event) => setLocale(event.target.value)} className="min-h-11 w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent">
          {shippedLocales.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label}
            </option>
          ))}
        </select>
      </Section>
    </div>
  );
}
