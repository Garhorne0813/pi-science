import { useTranslation } from "react-i18next";

export function ConversationWelcome() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start text-left">
      <div className="max-w-[500px]">
        <p className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-muted">{t("welcome.eyebrow")}</p>
        <h2 className="mt-1.5 font-sans text-[26px] font-medium leading-tight tracking-tight text-text">Pi-Science</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{t("welcome.description")}</p>
      </div>
    </div>
  );
}
