import { useTranslation } from "react-i18next";

export function ConversationWelcome() {
  const { t } = useTranslation();
  return (
    <h2 className="text-center font-sans text-2xl font-medium leading-tight tracking-tight text-text sm:text-[26px]">
      {t("welcome.researchGreeting")}
    </h2>
  );
}
