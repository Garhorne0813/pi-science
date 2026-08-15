import i18next, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { detectInitialLocale } from "./config";

const localeLoaders: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  en: () => import("./locales/en.json"),
  "zh-Hans": () => import("./locales/zh-Hans.json"),
};

const localeBackend: BackendModule = {
  type: "backend",
  init: () => undefined,
  read(language, _namespace, callback) {
    const loader = localeLoaders[language] ?? localeLoaders.en;
    void loader().then((module) => callback(null, module.default)).catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), false));
  },
};

export const i18nReady = i18next.use(localeBackend).use(initReactI18next).init({
  lng: detectInitialLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export { i18next };
export const i18n = i18next;
export default i18next;
