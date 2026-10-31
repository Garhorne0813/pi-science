import { useTranslation } from "react-i18next";
export function SettingsSaveMode({ automatic = false }: { automatic?: boolean }) {
  const { t } = useTranslation();
  return <p className="text-ui-caption text-muted">{t(automatic ? "settings.consistency.autoSave" : "settings.consistency.manualSave")}</p>;
}
