/**
 * Database management for Remem using Kysely
 */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import type {
  Activity,
  ConfigKey,
  DailySummary,
  Database,
  NewActivity,
} from "./schema.js";

/** Default data directory */
const USER_DATA_PATH = join(os.homedir(), ".remem");

/** Default template for daily reports */
const DEFAULT_TEMPLATE = `## 📅 Daily Report

### 🎯 Achievements
{{activities}}

### 📝 Notes
{{notes}}`;

/**
 * Database wrapper using Kysely for type-safe queries
 */
export class RememDatabase {
  private db: Kysely<Database>;
  private sqlite: BetterSqlite3.Database;

  constructor(dbPath?: string) {
    const dataPath = dbPath ?? USER_DATA_PATH;
    mkdirSync(dataPath, { recursive: true });

    this.sqlite = new BetterSqlite3(join(dataPath, "remem.db"));
    this.sqlite.pragma("journal_mode = WAL");

    this.db = new Kysely<Database>({
      dialect: new SqliteDialect({
        database: this.sqlite,
      }),
    });
  }

  /** Initialize database schema */
  async initialize(): Promise<void> {
    // Create activities table
    await sql`
      CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        content TEXT NOT NULL
      )
    `.execute(this.db);

    // Create daily_summaries table
    await sql`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        date TEXT PRIMARY KEY,
        summary TEXT NOT NULL
      )
    `.execute(this.db);

    // Create config table
    await sql`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `.execute(this.db);

    // Create indexes
    await sql`CREATE INDEX IF NOT EXISTS idx_activities_ts ON activities(ts)`.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type)`.execute(this.db);

    // Insert default config values
    await this.db
      .insertInto("config")
      .values({ key: "retention_days", value: "30" })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();

    await this.db
      .insertInto("config")
      .values({ key: "default_template", value: DEFAULT_TEMPLATE })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  }

  // --- Activities ---

  /** Insert a new activity */
  async insertActivity(type: string, content: string): Promise<void> {
    const newActivity: NewActivity = { type, content };
    await this.db.insertInto("activities").values(newActivity).execute();
  }

  /** Get activities for a specific date */
  async getActivitiesByDate(date: string): Promise<Activity[]> {
    return await this.db
      .selectFrom("activities")
      .selectAll()
      .where(sql`date(ts)`, "=", date)
      .orderBy("ts", "asc")
      .execute();
  }

  /** Delete activities older than specified days */
  async cleanupOldActivities(retentionDays: number): Promise<number> {
    const result = await this.db
      .deleteFrom("activities")
      .where(
        sql<boolean>`ts < datetime('now', '-' || ${retentionDays} || ' days')`
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  // --- Summaries ---

  /** Save or update a daily summary */
  async upsertSummary(date: string, summary: string): Promise<void> {
    await this.db
      .insertInto("daily_summaries")
      .values({ date, summary })
      .onConflict((oc) => oc.column("date").doUpdateSet({ summary }))
      .execute();
  }

  /** Get summaries for the past N months */
  async getSummariesByMonths(months: number): Promise<DailySummary[]> {
    return await this.db
      .selectFrom("daily_summaries")
      .selectAll()
      .where(
        sql<boolean>`date >= date('now', '-' || ${months} || ' months')`
      )
      .orderBy("date", "asc")
      .execute();
  }

  /** Get summary for a specific date */
  async getSummaryByDate(date: string): Promise<DailySummary | undefined> {
    return await this.db
      .selectFrom("daily_summaries")
      .selectAll()
      .where("date", "=", date)
      .executeTakeFirst();
  }

  // --- Config ---

  /** Get a config value */
  async getConfig(key: ConfigKey): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("config")
      .select("value")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value;
  }

  /** Set a config value */
  async setConfig(key: ConfigKey, value: string): Promise<void> {
    await this.db
      .insertInto("config")
      .values({ key, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
      .execute();
  }

  /** Get retention days as number */
  async getRetentionDays(): Promise<number> {
    const value = await this.getConfig("retention_days");
    return Number.parseInt(value ?? "30", 10);
  }

  /** Get default template */
  async getDefaultTemplate(): Promise<string> {
    return (await this.getConfig("default_template")) ?? "";
  }

  // --- Lifecycle ---

  /** Close the database connection */
  async close(): Promise<void> {
    await this.db.destroy();
  }
}

