import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RememDatabase } from "../src/database.js";
import { formatLocalTimestamp } from "../src/utils.js";

describe("local time handling", () => {
  let dbPath: string;
  let db: RememDatabase;

  /** Insert an activity with an exact `ts` value (stored as local time, like insertActivity) */
  async function insertAt(ts: string, content: string): Promise<void> {
    await db["db"].insertInto("activities").values({ type: "work", content, ts }).execute();
  }

  beforeEach(async () => {
    dbPath = join(tmpdir(), `remem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    db = new RememDatabase(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    try {
      rmSync(dbPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("returns activities on the local date they were logged, at any time of day", async () => {
    // Early morning and late evening are where a UTC/local mix-up shifts the date
    await insertAt("2026-01-21 00:00:00", "midnight");
    await insertAt("2026-01-21 03:00:00", "early-morning");
    await insertAt("2026-01-21 23:59:59", "late-evening");

    const activities = await db.getActivitiesByDate("2026-01-21");
    expect(activities.map((a) => a.content)).toEqual(["midnight", "early-morning", "late-evening"]);

    expect(await db.getActivitiesByDate("2026-01-20")).toHaveLength(0);
    expect(await db.getActivitiesByDate("2026-01-22")).toHaveLength(0);
  });

  it("deletes only activities older than the retention period", async () => {
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    await insertAt(formatLocalTimestamp(new Date(now - 49 * hour)), "expired");
    await insertAt(formatLocalTimestamp(new Date(now - 47 * hour)), "kept");

    const deleted = await db.cleanupOldActivities(2);
    expect(deleted).toBe(1);

    const remaining = await db["db"].selectFrom("activities").select("content").execute();
    expect(remaining.map((a) => a.content)).toEqual(["kept"]);
  });
});
