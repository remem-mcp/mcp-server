import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RememDatabase } from "../src/database.js";
import { formatLocalDate } from "../src/utils.js";

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

      // Use local date to match database storage
      const today = formatLocalDate();
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

      const today = formatLocalDate();
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

    it("should retrieve summaries by date range", async () => {
      await db.upsertSummary("2026-01-01", "January summary");
      await db.upsertSummary("2026-01-05", "Mid-January summary");
      await db.upsertSummary("2026-02-01", "February summary");

      const january = await db.getSummariesByRange("2026-01-01", "2026-01-31");
      expect(january.map((s) => s.date)).toEqual(["2026-01-01", "2026-01-05"]);
      expect(await db.getSummariesByRange()).toHaveLength(3);
      expect(await db.getSummariesByRange("2026-01-05")).toHaveLength(2);
    });

    it("should return undefined for non-existent summary", async () => {
      const summary = await db.getSummaryByDate("1999-01-01");
      expect(summary).toBeUndefined();
    });
  });

  describe("Projects and tags", () => {
    it("should store and return project and tags", async () => {
      await db.insertActivity("work", "Tagged", { project: " Remem ", tags: ["#review", "frontend", "review"] });
      await db.insertActivity("memo", "Plain");

      const activities = await db.getActivitiesByDate(formatLocalDate());
      expect(activities[0]).toMatchObject({ project: "Remem", tags: ["review", "frontend"] });
      expect(activities[1]).toMatchObject({ project: null, tags: [] });
    });

    it("should filter by project and by tags", async () => {
      await db.insertActivity("work", "A", { project: "Remem", tags: ["review"] });
      await db.insertActivity("work", "B", { project: "Remem", tags: ["frontend"] });
      await db.insertActivity("work", "C", { project: "Other", tags: ["review", "docs"] });
      await db.insertActivity("work", "D");

      const today = formatLocalDate();
      const contents = async (filter: Parameters<typeof db.getActivitiesByDate>[1]): Promise<string[]> =>
        (await db.getActivitiesByDate(today, filter)).map((a) => a.content);

      expect(await contents({ project: "Remem" })).toEqual(["A", "B"]);
      expect(await contents({ tags: ["review"] })).toEqual(["A", "C"]);
      expect(await contents({ tags: ["frontend", "docs"] })).toEqual(["B", "C"]);
      expect(await contents({ project: "Remem", tags: ["review"] })).toEqual(["A"]);
      expect(await contents({ project: "Missing" })).toEqual([]);
      expect(await contents({})).toHaveLength(4);
    });

    it("should treat tag text as data, not SQL", async () => {
      await db.insertActivity("work", "A", { tags: ["x') OR 1=1 --"] });
      await db.insertActivity("work", "B", { tags: ["safe"] });

      const today = formatLocalDate();
      expect(await db.getActivitiesByDate(today, { tags: ["x') OR 1=1 --"] })).toHaveLength(1);
      expect(await db.getActivitiesByDate(today, { tags: ["' OR '1'='1"] })).toHaveLength(0);
    });

    it("should list projects and tags with counts", async () => {
      await db.insertActivity("work", "A", { project: "Remem", tags: ["review"] });
      await db.insertActivity("work", "B", { project: "Remem", tags: ["review", "docs"] });
      await db.insertActivity("work", "C", { project: "Other" });

      expect(await db.listProjects()).toEqual([
        { name: "Remem", count: 2 },
        { name: "Other", count: 1 },
      ]);
      expect(await db.listTags()).toEqual([
        { name: "review", count: 2 },
        { name: "docs", count: 1 },
      ]);
    });
  });

  describe("Editing, time and search", () => {
    it("should store time spent, update and delete activities", async () => {
      const { id } = await db.insertActivity("work", "Original", { project: "Remem", tags: ["a"], minutes: 45 });
      expect(id).toBeGreaterThan(0);
      expect(await db.getActivity(id!)).toMatchObject({ content: "Original", minutes: 45 });

      // Only the given fields change
      await db.updateActivity(id!, { content: "Corrected" });
      expect(await db.getActivity(id!)).toMatchObject({ content: "Corrected", project: "Remem", tags: ["a"], minutes: 45 });

      await db.updateActivity(id!, { type: "decision", project: "", tags: [], minutes: null });
      expect(await db.getActivity(id!)).toMatchObject({ type: "decision", project: null, tags: [], minutes: null });

      expect((await db.updateActivity(9999, { content: "x" })).activity).toBeUndefined();
      expect(await db.deleteActivity(id!)).toBe(true);
      expect(await db.deleteActivity(id!)).toBe(false);
      expect(await db.getActivity(id!)).toBeUndefined();
    });

    it("should mask secrets before storing logs and reports", async () => {
      const log = await db.insertActivity("memo", "set password: hunter2abc for the test user");
      expect(log.redacted).toBe(1);
      expect((await db.getActivity(log.id!))?.content).toBe("set password: [REDACTED] for the test user");

      expect((await db.updateActivity(log.id!, { content: `token ghp_${"a".repeat(36)}` })).redacted).toBe(1);
      expect((await db.upsertSummary("2026-01-20", "api_key=abcdef123456", "use sk-" + "x".repeat(30))).redacted).toBe(2);
      expect(await db.getSummaryByDate("2026-01-20")).toMatchObject({ summary: "api_key=[REDACTED]", next_plan: "use [REDACTED]" });
      expect((await db.upsertPeriodSummary("weekly", "2026-01-19", "2026-01-25", "clean text")).redacted).toBe(0);
    });

    it("should add up counts and time by project, type, tag and day", async () => {
      const at = (ts: string, minutes: number | undefined, project?: string, tags?: string[]): Promise<unknown> =>
        db.insertActivity("work", "x", { timestamp: ts, minutes, project, tags });
      await at("2026-01-20 09:00:00", 60, "Remem", ["dev"]);
      await at("2026-01-20 13:00:00", 30, "Remem", ["dev", "review"]);
      await at("2026-01-21 09:00:00", 120, "Other");
      await at("2026-01-21 10:00:00", undefined);
      await at("2026-02-01 09:00:00", 999, "Outside");

      const stats = await db.getStats("2026-01-01", "2026-01-31");
      expect(stats).toMatchObject({ count: 4, minutes: 210 });
      expect(stats.byProject).toEqual([
        { name: "Other", count: 1, minutes: 120 },
        { name: "Remem", count: 2, minutes: 90 },
        { name: "", count: 1, minutes: 0 },
      ]);
      expect(stats.byTag).toEqual([
        { name: "dev", count: 2, minutes: 90 },
        { name: "review", count: 1, minutes: 30 },
      ]);
      expect(stats.byDay.map((day) => [day.name, day.minutes])).toEqual([
        ["2026-01-20", 90],
        ["2026-01-21", 120],
      ]);
      expect((await db.getStats("2026-01-01", "2026-01-31", { project: "Remem" })).minutes).toBe(90);
    });

    it("should search logs and reports for all words", async () => {
      await db.insertActivity("work", "検索機能を実装", { project: "受注管理", tags: ["frontend"], timestamp: "2026-01-20 09:00:00" });
      await db.insertActivity("decision", "Use Kysely for queries", { timestamp: "2026-01-21 09:00:00" });
      await db.upsertSummary("2026-01-20", "検索機能のレビューを実施", "- 性能計測");
      await db.upsertPeriodSummary("weekly", "2026-01-19", "2026-01-25", "検索機能をリリース");

      const found = await db.search("検索");
      expect(found.activities.map((a) => a.content)).toEqual(["検索機能を実装"]);
      expect(found.daily).toHaveLength(1);
      expect(found.weekly).toHaveLength(1);

      expect((await db.search("検索 レビュー")).daily).toHaveLength(1);
      expect((await db.search("検索 レビュー")).activities).toHaveLength(0);
      expect((await db.search("kysely")).activities).toHaveLength(1);
      expect((await db.search("受注管理")).activities).toHaveLength(1);
      expect((await db.search("frontend")).activities).toHaveLength(1);
      expect((await db.search("性能計測")).daily).toHaveLength(1);
      expect((await db.search("検索", { from: "2026-01-21" })).activities).toHaveLength(0);
      expect((await db.search("   ")).activities).toHaveLength(0);
    });

    it("should rank better matches first and fall back to partial matches", async () => {
      await db.insertActivity("work", "search once", { timestamp: "2026-01-22 09:00:00" });
      await db.insertActivity("work", "search search search", { timestamp: "2026-01-20 09:00:00" });
      await db.insertActivity("work", "unrelated text", { project: "search", timestamp: "2026-01-21 09:00:00" });
      await db.insertActivity("work", "nothing here", { timestamp: "2026-01-23 09:00:00" });

      const ranked = await db.search("search");
      expect(ranked.partial).toBe(false);
      // A match in the project name counts more than one mention; more mentions rank higher
      expect(ranked.activities.map((a) => a.content)).toEqual(["unrelated text", "search search search", "search once"]);

      // No entry has both words: results with one of them are returned, marked as partial
      const partial = await db.search("search zebra");
      expect(partial.partial).toBe(true);
      expect(partial.activities).toHaveLength(3);

      // As soon as something contains every word, only those are returned
      await db.insertActivity("memo", "search for the zebra");
      const full = await db.search("Search ZEBRA");
      expect(full.partial).toBe(false);
      expect(full.activities.map((a) => a.content)).toEqual(["search for the zebra"]);

      expect((await db.search("search", { limit: 2 })).activities).toHaveLength(2);
      expect((await db.search("zzz")).partial).toBe(true);
    });

    it("should treat search wildcards and quotes as plain text", async () => {
      await db.insertActivity("memo", "progress is 100% done");
      await db.insertActivity("memo", "plain note");
      expect((await db.search("%")).activities).toHaveLength(1);
      expect((await db.search("_")).activities).toHaveLength(0);
      expect((await db.search("' OR '1'='1")).activities).toHaveLength(0);
    });
  });

  describe("Period summaries", () => {
    it("should insert, update and retrieve weekly and monthly summaries", async () => {
      await db.upsertPeriodSummary("weekly", "2026-01-19", "2026-01-25", "Week v1");
      await db.upsertPeriodSummary("weekly", "2026-01-19", "2026-01-25", "Week v2");
      await db.upsertPeriodSummary("monthly", "2026-01-01", "2026-01-31", "January");

      expect((await db.getPeriodSummary("weekly", "2026-01-19"))?.summary).toBe("Week v2");
      expect((await db.getPeriodSummary("monthly", "2026-01-01"))?.summary).toBe("January");
      expect(await db.getPeriodSummary("weekly", "2026-01-12")).toBeUndefined();
      // Weekly and monthly entries with the same start date do not collide
      await db.upsertPeriodSummary("weekly", "2026-01-01", "2026-01-07", "Odd week");
      expect((await db.getPeriodSummary("monthly", "2026-01-01"))?.summary).toBe("January");
    });

    it("should retrieve period summaries that overlap a range", async () => {
      await db.upsertPeriodSummary("weekly", "2026-01-12", "2026-01-18", "W3");
      await db.upsertPeriodSummary("weekly", "2026-01-19", "2026-01-25", "W4");
      await db.upsertPeriodSummary("weekly", "2026-01-26", "2026-02-01", "W5");

      const rows = await db.getPeriodSummariesByRange("weekly", "2026-01-20", "2026-01-27");
      expect(rows.map((r) => r.summary)).toEqual(["W4", "W5"]);
      expect(await db.getPeriodSummariesByRange("weekly")).toHaveLength(3);
      expect(await db.getPeriodSummariesByRange("monthly")).toHaveLength(0);
    });
  });

  describe("Migration", () => {
    it("should upgrade a 1.x database without losing data", async () => {
      const legacyDir = join(tmpdir(), `remem-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(legacyDir, { recursive: true });
      const legacy = new BetterSqlite3(join(legacyDir, "remem.db"));
      legacy.exec(`
        CREATE TABLE activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts DATETIME DEFAULT CURRENT_TIMESTAMP,
          type TEXT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE TABLE daily_summaries (date TEXT PRIMARY KEY, summary TEXT NOT NULL);
        CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO activities (ts, type, content) VALUES ('2026-01-21 10:00:00', 'work', 'legacy entry');
        INSERT INTO daily_summaries VALUES ('2026-01-21', 'legacy summary');
        INSERT INTO config VALUES ('retention_days', '90');
      `);
      legacy.close();

      const upgraded = new RememDatabase(legacyDir);
      try {
        await upgraded.initialize();
        // Running the migration twice must be harmless
        await upgraded.initialize();

        const activities = await upgraded.getActivitiesByDate("2026-01-21");
        expect(activities).toHaveLength(1);
        expect(activities[0]).toMatchObject({ content: "legacy entry", project: null, tags: [] });
        expect((await upgraded.getSummaryByDate("2026-01-21"))?.summary).toBe("legacy summary");
        expect(await upgraded.getRetentionDays()).toBe(90);
        expect(await upgraded.getWeekStart()).toBe("monday");

        // Columns added in 2.0 work on the upgraded database
        await upgraded.upsertSummary("2026-01-21", "legacy summary", "- plan");
        expect((await upgraded.getSummaryByDate("2026-01-21"))?.next_plan).toBe("- plan");
        const timed = await upgraded.insertActivity("work", "timed", { minutes: 15, source: "git:abc" });
        expect((await upgraded.getActivity(timed.id!))?.minutes).toBe(15);
        expect((await upgraded.insertActivity("work", "timed again", { source: "git:abc" })).duplicate).toBe(true);

        await upgraded.insertActivity("work", "new entry", { project: "Remem", tags: ["v2"] });
        expect(await upgraded.listProjects()).toEqual([{ name: "Remem", count: 1 }]);
      } finally {
        await upgraded.close();
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });
  });

  describe("Config", () => {
    it("should have weekly and monthly templates and a week start", async () => {
      expect(await db.getPeriodTemplate("weekly")).toContain("Weekly Report");
      expect(await db.getPeriodTemplate("monthly")).toContain("Monthly Report");
      expect(await db.getWeekStart()).toBe("monday");

      await db.setConfig("week_start", "sunday");
      expect(await db.getWeekStart()).toBe("sunday");
    });

    it("should fall back to 30 days when retention_days is not a number", async () => {
      await db.setConfig("retention_days", "not-a-number");
      expect(await db.getRetentionDays()).toBe(30);
    });

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
