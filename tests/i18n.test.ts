import { describe, expect, it } from "vitest";

import { detectLanguage, getUiMessages, initI18n } from "../src/i18n.js";
import en from "../src/locales/en.json" with { type: "json" };
import ja from "../src/locales/ja.json" with { type: "json" };

/** Collect every key path of a nested object */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe("i18n", () => {
  describe("detectLanguage", () => {
    it("should use POSIX locale variables", () => {
      expect(detectLanguage({ LANG: "ja_JP.UTF-8" }, "en-US")).toBe("ja");
      expect(detectLanguage({ LANG: "en_US.UTF-8" }, "ja-JP")).toBe("en");
      expect(detectLanguage({ LC_ALL: "ja_JP.UTF-8", LANG: "en_US.UTF-8" }, "en-US")).toBe("ja");
    });

    it("should let REMEM_LANG override everything", () => {
      expect(detectLanguage({ REMEM_LANG: "ja", LANG: "en_US.UTF-8" }, "en-US")).toBe("ja");
      expect(detectLanguage({ REMEM_LANG: "en", LANG: "ja_JP.UTF-8" }, "ja-JP")).toBe("en");
    });

    it("should fall back to the system locale when no variable is set (e.g. Windows)", () => {
      expect(detectLanguage({}, "ja-JP")).toBe("ja");
      expect(detectLanguage({}, "en-GB")).toBe("en");
      expect(detectLanguage({ LANG: "C" }, "ja-JP")).toBe("ja");
      expect(detectLanguage({ LANG: "C.UTF-8", LC_ALL: "POSIX" }, "ja")).toBe("ja");
    });

    it("should default to English for other languages", () => {
      expect(detectLanguage({ LANG: "fr_FR.UTF-8" }, "fr-FR")).toBe("en");
    });
  });

  describe("initI18n", () => {
    it("should initialize with Japanese", async () => {
      const t = await initI18n("ja");
      expect(t("log.success", { type: "work" })).toContain("記録完了");
      expect(t("summary.saved")).toContain("保存");
    });

    it("should initialize with English", async () => {
      const t = await initI18n("en");
      expect(t("log.success", { type: "work" })).toContain("Logged");
      expect(t("summary.saved")).toContain("saved");
    });

    it("should format config.updated message", async () => {
      const t = await initI18n("en");
      const result = t("config.updated", { key: "retention_days", value: "60" });
      expect(result).toContain("retention_days");
      expect(result).toContain("60");
    });

    it("should keep languages independent of each other", async () => {
      const tJa = await initI18n("ja");
      const tEn = await initI18n("en");
      expect(tJa("language.name")).toBe("日本語");
      expect(tEn("language.name")).toBe("English");
    });
  });

  describe("locale files", () => {
    it("should define the same keys in every language", () => {
      expect(keyPaths(ja).sort()).toEqual(keyPaths(en).sort());
    });

    it("should return dashboard messages per language", () => {
      expect(getUiMessages("ja").save).toBe("保存");
      expect(getUiMessages("en").save).toBe("Save");
    });
  });
});
