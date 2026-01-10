import { describe, expect, it } from "vitest";

import { detectLanguage, initI18n } from "../src/i18n.js";

describe("i18n", () => {
  describe("detectLanguage", () => {
    it("should detect language from environment", () => {
      // Note: This test depends on the actual environment
      const lang = detectLanguage();
      expect(["ja", "en"]).toContain(lang);
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
  });
});
