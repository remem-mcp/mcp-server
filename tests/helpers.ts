import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RememDatabase } from "../src/database.js";

/** Create an initialized database in a unique temporary directory */
export async function createTestDatabase(): Promise<{ db: RememDatabase; dir: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), `remem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = new RememDatabase(dir);
  await db.initialize();
  return {
    db,
    dir,
    cleanup: async () => {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insert an activity with an exact local `ts` value */
export async function insertAt(
  db: RememDatabase,
  ts: string,
  content: string,
  labels: { project?: string | null; tags?: string[] } = {}
): Promise<void> {
  await db["db"]
    .insertInto("activities")
    .values({ type: "work", content, ts, project: labels.project ?? null, tags: JSON.stringify(labels.tags ?? []) })
    .execute();
}
