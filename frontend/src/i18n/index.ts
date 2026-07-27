import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { detectInitialLocale } from "./config";
import en from "./locales/en.json";
import zhHans from "./locales/zh-Hans.json";

export const resources = {
  en: { translation: en },
  "zh-Hans": { translation: zhHans },
} as const;

i18next.use(initReactI18next).init({
  resources,
  lng: detectInitialLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export { i18next };
export const i18n = i18next;
export default i18next;
