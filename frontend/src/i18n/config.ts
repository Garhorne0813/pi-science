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

/** Resolve a concrete shipped locale from the browser/system language. */
export function detectSystemLocale(): string {
  const browserLang = typeof navigator === "undefined" ? "" : navigator.language || "";
  for (const loc of shippedLocales) {
    if (browserLang === loc.code || browserLang.startsWith(loc.code.split("-")[0])) {
      return loc.code;
    }
  }
  return DEFAULT_LOCALE;
}

/** Initial locale for i18next and the store: a concrete shipped code, never
 *  the "system" marker (i18next uses it as its active language). A stored
 *  "system" selection falls through to browser-language detection. */
export function detectInitialLocale(): string {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(LOCALE_KEY);
      if (stored) {
        const choice: unknown = JSON.parse(stored);
        if (choice !== "system") return resolveLocale(String(choice));
      }
    } catch { /* ignore */ }
  }
  return detectSystemLocale();
}

/** The actual active language for a user choice: "system" tracks the
 *  browser/system language; anything else resolves through shippedLocales. */
export function resolveEffectiveLocale(choice: string): string {
  return choice === "system" ? detectSystemLocale() : resolveLocale(choice);
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
