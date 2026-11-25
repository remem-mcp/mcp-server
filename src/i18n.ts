/**
 * Internationalization setup using i18next
 */

import i18next, { type TFunction } from "i18next";

import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };

/** Supported languages */
export type SupportedLanguage = "en" | "ja";

/** Strings shown by the web dashboard */
export type UiMessages = typeof en.ui;

/** Locale values that mean "no language configured" */
const NEUTRAL_LOCALES = new Set(["", "c", "posix"]);

/**
 * Detect the language to use.
 *
 * Order: `REMEM_LANG`, the POSIX locale variables, then the operating system
 * locale reported by `Intl` (which is what works on Windows, where the POSIX
 * variables are normally unset).
 */
export function detectLanguage(
  env: NodeJS.ProcessEnv = process.env,
  systemLocale: string = Intl.DateTimeFormat().resolvedOptions().locale
): SupportedLanguage {
  const candidates = [env.REMEM_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE, systemLocale];
  for (const candidate of candidates) {
    const locale = (candidate ?? "").trim().toLowerCase();
    if (NEUTRAL_LOCALES.has(locale) || locale.startsWith("c.")) continue;
    return locale.startsWith("ja") ? "ja" : "en";
  }
  return "en";
}

/** Initialize i18next and return the t function */
export async function initI18n(lng?: SupportedLanguage): Promise<TFunction> {
  const instance = i18next.createInstance();
  await instance.init({
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

  return instance.t.bind(instance);
}

/** Get the dashboard strings for a language */
export function getUiMessages(language: SupportedLanguage): UiMessages {
  return language === "ja" ? ja.ui : en.ui;
}
