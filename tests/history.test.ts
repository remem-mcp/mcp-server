import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RememDatabase } from "../src/database.js";
import { addMonths, formatLocalDate, formatLocalTimestamp } from "../src/utils.js";
import { createTestDatabase, insertAt } from "./helpers.js";

describe("local time handling", () => {
  let db: RememDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDatabase());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("returns activities on the local date they were logged, at any time of day", async () => {
    // Early morning and late evening are where a UTC/local mix-up shifts the date
    await insertAt(db, "2026-01-21 00:00:00", "midnight");
    await insertAt(db, "2026-01-21 03:00:00", "early-morning");
    await insertAt(db, "2026-01-21 23:59:59", "late-evening");

    const activities = await db.getActivitiesByDate("2026-01-21");
    expect(activities.map((a) => a.content)).toEqual(["midnight", "early-morning", "late-evening"]);

    expect(await db.getActivitiesByDate("2026-01-20")).toHaveLength(0);
    expect(await db.getActivitiesByDate("2026-01-22")).toHaveLength(0);
  });

  it("returns activities in an inclusive date range", async () => {
    await insertAt(db, "2026-01-18 23:59:59", "before");
    await insertAt(db, "2026-01-19 00:00:00", "first");
    await insertAt(db, "2026-01-25 23:59:59", "last");
    await insertAt(db, "2026-01-26 00:00:00", "after");

    const activities = await db.getActivitiesByRange("2026-01-19", "2026-01-25");
    expect(activities.map((a) => a.content)).toEqual(["first", "last"]);
  });

  it("deletes only activities older than the retention period", async () => {
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    await insertAt(db, formatLocalTimestamp(new Date(now - 49 * hour)), "expired");
    await insertAt(db, formatLocalTimestamp(new Date(now - 47 * hour)), "kept");

    const deleted = await db.cleanupOldActivities(2);
    expect(deleted).toBe(1);

    const remaining = await db.getActivitiesByRange("0000-01-01", "9999-12-31");
    expect(remaining.map((a) => a.content)).toEqual(["kept"]);
  });

  it("returns only summaries inside the look-back window", async () => {
    const today = formatLocalDate();
    await db.upsertSummary(addMonths(today, -3), "three months ago");
    await db.upsertSummary(addMonths(today, -1), "last month");
    await db.upsertSummary(today, "today");

    expect((await db.getSummariesByMonths(2)).map((s) => s.summary)).toEqual(["last month", "today"]);
    expect(await db.getSummariesByMonths(6)).toHaveLength(3);
  });
});
