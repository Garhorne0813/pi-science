import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ExtCard({ name, pkg, desc, checked }: { name: string; pkg: string; desc: string; checked: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 mb-2">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <span className="text-sm font-medium text-text">{name}</span>
          <span className="ml-2 font-mono text-[10px] text-muted">{pkg}</span>
          <p className="text-[11px] text-muted mt-0.5">{desc}</p>
        </div>
        {checked ? (
          <span className="rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok ring-1 ring-ok/30">
            <Check size={10} className="inline mr-0.5" />
            {t("settings.extensionsPage.installed")}
          </span>
        ) : (
          <span className="rounded-full bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error ring-1 ring-error/20">{t("settings.extensionsPage.missing")}</span>
        )}
      </div>
    </div>
  );
}
