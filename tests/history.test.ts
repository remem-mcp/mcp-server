import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RememDatabase } from '../src/database.js';
import { sql } from 'kysely';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

describe('history timezone handling', () => {
  let dbPath: string;
  let db: RememDatabase;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `remem-test-${Date.now()}`);
    db = new RememDatabase(dbPath);
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    try {
      rmSync(dbPath, { recursive: true, force: true });
    } catch (_e) {
      // ignore
    }
  });

  it("fails when an activity stored as UTC for JST 03:00 isn't found for that local date", async () => {
    // Arrange: the activity actually occurred at 2026-01-21 03:00:00 JST.
    // If stored as UTC it will be '2026-01-20 18:00:00'.
    const tsUtcForJst0300 = '2026-01-20 18:00:00'; // UTC representation of 2026-01-21 03:00:00 JST

    // Direct DB insert to control the ts value exactly (simulate a UTC timestamp being stored)
    // @ts-expect-error access private field for test
    await db['db'].insertInto('activities').values({ type: 'work', content: 'utc-for-jst-0300', ts: tsUtcForJst0300 }).execute();

    // Act: raw SQL using date(ts) WITHOUT 'localtime' should miss the entry
    // @ts-expect-error access private field for test
    const raw = await db['db']
      .selectFrom('activities')
      .selectAll()
      .where(sql`date(ts)`, '=', '2026-01-21')
      .execute();

    // raw result should be empty because date(ts) treats ts as UTC here
    expect(raw.length).toBe(0);

    // Also check the public helper which should use localtime-aware query and find the entry
    const activities = await db.getActivitiesByDate('2026-01-21');
    expect(activities.length).toBeGreaterThan(0);
  });
});
