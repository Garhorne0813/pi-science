import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Icon } from "../ui/Icon";

export function ExtCard({ name, pkg, desc, checked }: { name: string; pkg: string; desc: string; checked: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-14 w-full items-center justify-between gap-panel border-b border-faint py-2">
      <div className="flex w-full items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-ui-label font-medium text-text">{name}</span>
          <span className="ml-2 font-mono text-ui-caption text-muted">{pkg}</span>
          <p className="mt-0.5 text-ui-caption text-muted">{desc}</p>
        </div>
        {checked ? (
          <span className="ml-auto shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok ring-1 ring-ok/30">
            <Icon icon={Check} size="xs" className="mr-0.5 inline" />
            {t("settings.extensionsPage.installed")}
          </span>
        ) : (
          <span className="ml-auto shrink-0 rounded-full bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error ring-1 ring-error/20">{t("settings.extensionsPage.missing")}</span>
        )}
      </div>
    </div>
  );
}
