/** i18n configuration — ported from open-science. */

export const LOCALE_KEY = "pi-science.locale";
export const DEFAULT_LOCALE = "en";

export interface LocaleDef {
  code: string;
  label: string;
}

export const shippedLocales: LocaleDef[] = [
  { code: "en", label: "English" },
  { code: "zh-Hans", label: "简体中文" },
];

export function detectInitialLocale(): string {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(LOCALE_KEY);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
  }

  const browserLang = typeof navigator === "undefined" ? "" : navigator.language || "";
  for (const loc of shippedLocales) {
    if (browserLang === loc.code || browserLang.startsWith(loc.code.split("-")[0])) {
      return loc.code;
    }
  }
  return DEFAULT_LOCALE;
}

export function resolveLocale(requested: string): string {
  for (const loc of shippedLocales) {
    if (requested === loc.code) return loc.code;
  }
  // Try base language match
  const base = requested.split("-")[0];
  for (const loc of shippedLocales) {
    if (loc.code.startsWith(base)) return loc.code;
  }
  return DEFAULT_LOCALE;
}
