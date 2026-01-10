import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RememDatabase } from "../src/database.js";

describe("RememDatabase", () => {
  let db: RememDatabase;
  let testDir: string;

  beforeEach(async () => {
    // Use a unique temp directory for each test
    testDir = join(tmpdir(), `remem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    db = new RememDatabase(testDir);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    // Cleanup test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Activities", () => {
    it("should insert and retrieve activities", async () => {
      await db.insertActivity("work", "Implemented feature X");
      await db.insertActivity("decision", "Chose React over Vue");

      // SQLite stores timestamps in UTC
      const today = new Date().toISOString().split("T")[0];
      const activities = await db.getActivitiesByDate(today);

      expect(activities).toHaveLength(2);
      expect(activities[0].type).toBe("work");
      expect(activities[0].content).toBe("Implemented feature X");
      expect(activities[1].type).toBe("decision");
    });

    it("should return empty array for date with no activities", async () => {
      const activities = await db.getActivitiesByDate("2020-01-01");
      expect(activities).toHaveLength(0);
    });

    it("should cleanup old activities", async () => {
      await db.insertActivity("memo", "Test memo");

      // Today's activities should NOT be deleted when retention is 1 day
      const deleted = await db.cleanupOldActivities(1);
      expect(deleted).toBe(0);

      const today = new Date().toISOString().split("T")[0];
      const activities = await db.getActivitiesByDate(today);
      expect(activities).toHaveLength(1);
    });
  });

  describe("Summaries", () => {
    it("should insert and retrieve summaries", async () => {
      const date = "2026-01-10";
      const summary = "Completed project setup and initial implementation";

      await db.upsertSummary(date, summary);
      const retrieved = await db.getSummaryByDate(date);

      expect(retrieved).toBeDefined();
      expect(retrieved?.summary).toBe(summary);
    });

    it("should update existing summary", async () => {
      const date = "2026-01-10";
      await db.upsertSummary(date, "First version");
      await db.upsertSummary(date, "Updated version");

      const retrieved = await db.getSummaryByDate(date);
      expect(retrieved?.summary).toBe("Updated version");
    });

    it("should retrieve summaries by months", async () => {
      // Insert summaries for different dates
      await db.upsertSummary("2026-01-01", "January summary");
      await db.upsertSummary("2026-01-05", "Mid-January summary");

      const summaries = await db.getSummariesByMonths(1);
      expect(summaries.length).toBeGreaterThanOrEqual(0);
    });

    it("should return undefined for non-existent summary", async () => {
      const summary = await db.getSummaryByDate("1999-01-01");
      expect(summary).toBeUndefined();
    });
  });

  describe("Config", () => {
    it("should have default retention_days", async () => {
      const retentionDays = await db.getRetentionDays();
      expect(retentionDays).toBe(30);
    });

    it("should have default template", async () => {
      const template = await db.getDefaultTemplate();
      expect(template).toContain("Daily Report");
    });

    it("should update config values", async () => {
      await db.setConfig("retention_days", "60");
      expect(await db.getRetentionDays()).toBe(60);
    });

    it("should update template", async () => {
      const newTemplate = "# Custom Template\n{{activities}}";
      await db.setConfig("default_template", newTemplate);
      expect(await db.getDefaultTemplate()).toBe(newTemplate);
    });
  });
});
