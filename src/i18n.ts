/**
 * Internationalization setup using i18next
 */

import i18next, { type TFunction } from "i18next";

import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };

/** Supported languages */
export type SupportedLanguage = "en" | "ja";

/** Detect language from environment */
export function detectLanguage(): SupportedLanguage {
  const lang = process.env.LANG ?? process.env.LANGUAGE ?? "";
  return lang.startsWith("ja") ? "ja" : "en";
}

/** Initialize i18next and return the t function */
export async function initI18n(lng?: SupportedLanguage): Promise<TFunction> {
  await i18next.init({
    lng: lng ?? detectLanguage(),
    fallbackLng: "en",
    interpolation: {
      escapeValue: false, // Not needed for non-HTML output
    },
    resources: {
      en: { translation: en },
      ja: { translation: ja },
    },
  });

  return i18next.t.bind(i18next);
}

/** Get the current language */
export function getCurrentLanguage(): SupportedLanguage {
  return (i18next.language as SupportedLanguage) ?? "en";
}

/** Get the t function (after initialization) */
export function getT(): TFunction {
  return i18next.t.bind(i18next);
}
