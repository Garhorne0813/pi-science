import { useTranslation } from "react-i18next";
import { shippedLocales } from "../../i18n/config";
import { useUiStore } from "../../lib/ui";
import { SettingsSelectMenu } from "./SettingsSelectMenu";

export function GeneralTab() {
  const { t } = useTranslation();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const locale = useUiStore((state) => state.locale);
  const setLocale = useUiStore((state) => state.setLocale);
  const previewPaneSide = useUiStore((state) => state.previewPaneSide);
  const setPreviewPaneSide = useUiStore((state) => state.setPreviewPaneSide);
  return (
    <section className="divide-y divide-faint overflow-hidden rounded-card border border-faint bg-surface-2/40">
      <div className="flex min-h-14 items-center justify-between gap-panel px-4 py-2">
        <span className="text-ui-label font-medium text-text">{t("settings.appearance.label")}</span>
        <SettingsSelectMenu
          ariaLabel={t("settings.appearance.label")}
          value={theme}
          options={[
            { value: "system", label: t("settings.appearance.system") },
            { value: "light", label: t("settings.appearance.light") },
            { value: "dark", label: t("settings.appearance.dark") },
          ]}
          className="min-w-[12rem]"
          onSelect={(next) => setTheme(next as "light" | "dark" | "system")}
        />
      </div>
      <div className="flex min-h-14 items-center justify-between gap-panel px-4 py-2">
        <span className="text-ui-label font-medium text-text">{t("settings.language.label")}</span>
        <SettingsSelectMenu
          ariaLabel={t("settings.language.label")}
          value={locale}
          options={[
            { value: "system", label: t("settings.language.system") },
            ...shippedLocales.map((entry) => ({ value: entry.code, label: entry.label })),
          ]}
          className="min-w-[12rem]"
          onSelect={(next) => setLocale(next)}
        />
      </div>
      <div className="flex min-h-14 items-center justify-between gap-panel px-4 py-2">
        <span className="text-ui-label font-medium text-text">{t("settings.layout.panelOrder.label")}</span>
        <SettingsSelectMenu
          ariaLabel={t("settings.layout.panelOrder.label")}
          value={previewPaneSide}
          options={[
            { value: "right", label: t("settings.layout.panelOrder.conversationPreview") },
            { value: "left", label: t("settings.layout.panelOrder.previewConversation") },
          ]}
          className="min-w-[12rem]"
          onSelect={(next) => setPreviewPaneSide(next as "left" | "right")}
        />
      </div>
    </section>
  );
}
