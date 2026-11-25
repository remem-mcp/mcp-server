/**
 * Database management for Remem using Kysely
 */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { redactSecrets } from "./redact.js";
import type {
  Activity,
  ActivityFilter,
  ActivityInput,
  ActivityStats,
  ConfigKey,
  DailySummary,
  Database,
  LabelCount,
  PeriodSummary,
  PeriodType,
  SearchResults,
  StatGroup,
  WeekStart,
} from "./schema.js";
import { formatLocalTimestamp, normalizeProject, normalizeTags } from "./utils.js";

/** Most rows read per kind before ranking search results */
const SEARCH_CANDIDATES = 2000;

/** Current schema version, stored in SQLite's `user_version` pragma */
const SCHEMA_VERSION = 3;

/** Default template for daily reports */
const DEFAULT_TEMPLATE = `## 📅 Daily Report

### 🎯 Achievements
{{activities}}

### 📝 Notes
{{notes}}`;

/** Default template for weekly reports */
const DEFAULT_WEEKLY_TEMPLATE = `## 🗓️ Weekly Report

### 🎯 Highlights
{{highlights}}

### 📂 By Project
{{projects}}

### 🔭 Next Week
{{next}}`;

/** Default template for monthly reports */
const DEFAULT_MONTHLY_TEMPLATE = `## 📆 Monthly Report

### 🎯 Highlights
{{highlights}}

### 📂 By Project
{{projects}}

### 💡 Learnings
{{learnings}}

### 🔭 Next Month
{{next}}`;

/** Default config values, inserted when missing */
const DEFAULT_CONFIG: Record<ConfigKey, string> = {
  retention_days: "30",
  default_template: DEFAULT_TEMPLATE,
  weekly_template: DEFAULT_WEEKLY_TEMPLATE,
  monthly_template: DEFAULT_MONTHLY_TEMPLATE,
  week_start: "monday",
};

/** Resolve the data directory: explicit path, then REMEM_DATA_DIR, then ~/.remem */
export function resolveDataPath(dbPath?: string): string {
  const fromEnv = process.env.REMEM_DATA_DIR?.trim();
  return dbPath ?? (fromEnv ? fromEnv : join(os.homedir(), ".remem"));
}

/** Decode the JSON tag column, tolerating malformed data */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/** Convert a stored row to the activity shape given to callers (hides internal columns) */
function toActivity(row: {
  id: number;
  ts: string;
  type: string;
  content: string;
  project: string | null;
  tags: string;
  minutes: number | null;
}): Activity {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    content: row.content,
    project: row.project,
    tags: parseTags(row.tags),
    minutes: row.minutes,
  };
}

/**
 * Database wrapper using Kysely for type-safe queries
 */
export class RememDatabase {
  private db: Kysely<Database>;
  private sqlite: BetterSqlite3.Database;

  /** Directory that holds the database file (and exports) */
  readonly dataPath: string;

  constructor(dbPath?: string) {
    this.dataPath = resolveDataPath(dbPath);
    mkdirSync(this.dataPath, { recursive: true });

    this.sqlite = new BetterSqlite3(join(this.dataPath, "remem.db"));
    this.sqlite.pragma("journal_mode = WAL");
    // The MCP server and the dashboard may use the same file at the same time
    this.sqlite.pragma("busy_timeout = 5000");

    this.db = new Kysely<Database>({
      dialect: new SqliteDialect({
        database: this.sqlite,
      }),
    });
  }

  /** Initialize database schema and apply migrations */
  async initialize(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        project TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        minutes INTEGER,
        source TEXT
      )
    `.execute(this.db);

    await sql`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        date TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        next_plan TEXT
      )
    `.execute(this.db);

    await sql`
      CREATE TABLE IF NOT EXISTS period_summaries (
        type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        summary TEXT NOT NULL,
        PRIMARY KEY (type, period_start)
      )
    `.execute(this.db);

    await sql`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `.execute(this.db);

    this.migrate();

    await sql`CREATE INDEX IF NOT EXISTS idx_activities_ts ON activities(ts)`.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type)`.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project)`.execute(this.db);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_source ON activities(source) WHERE source IS NOT NULL`.execute(
      this.db
    );

    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      await this.db
        .insertInto("config")
        .values({ key, value })
        .onConflict((oc) => oc.column("key").doNothing())
        .execute();
    }
  }

  /**
   * Bring databases created by older versions up to the current schema.
   * Version 1 (Remem 1.x) had only `id`, `ts`, `type` and `content` on
   * activities, and no `next_plan` on daily summaries.
   */
  private migrate(): void {
    const version = Number(this.sqlite.pragma("user_version", { simple: true }));
    if (version >= SCHEMA_VERSION) return;

    const addMissingColumns = (table: string, columns: Record<string, string>): void => {
      const existing = (this.sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
      for (const [name, definition] of Object.entries(columns)) {
        if (!existing.includes(name)) this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };

    const upgrade = this.sqlite.transaction(() => {
      addMissingColumns("activities", {
        project: "TEXT",
        tags: "TEXT NOT NULL DEFAULT '[]'",
        minutes: "INTEGER",
        source: "TEXT",
      });
      addMissingColumns("daily_summaries", { next_plan: "TEXT" });
      this.sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    upgrade();
  }

  // --- Activities ---

  /**
   * Insert a new activity.
   *
   * The `ts` field is explicitly set to local time (YYYY-MM-DD HH:MM:SS format)
   * rather than using the database's default CURRENT_TIMESTAMP (which is UTC).
   * This ensures date-based queries using `date(ts)` work correctly in the user's timezone.
   *
   * Anything in the content that looks like a credential is masked before it is stored.
   *
   * @param type - Activity type: 'work', 'decision', 'memo', or 'approval'
   * @param content - The activity content to log
   * @param options - Project, tags, time spent, and (for imports and back-dated entries) timestamp and source
   * @returns The new id, how many secrets were masked, and whether an entry with the same source already existed
   */
  async insertActivity(
    type: string,
    content: string,
    options: ActivityInput & { timestamp?: string; source?: string } = {}
  ): Promise<{ id: number | null; redacted: number; duplicate: boolean }> {
    const safe = redactSecrets(content);
    const result = await this.db
      .insertInto("activities")
      .values({
        type,
        content: safe.text,
        ts: options.timestamp ?? formatLocalTimestamp(),
        project: normalizeProject(options.project),
        tags: JSON.stringify(normalizeTags(options.tags)),
        minutes: options.minutes ?? null,
        source: options.source ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();

    const inserted = Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
    return {
      id: inserted && result.insertId !== undefined ? Number(result.insertId) : null,
      redacted: safe.count,
      duplicate: !inserted,
    };
  }

  /** Get one activity by id */
  async getActivity(id: number): Promise<Activity | undefined> {
    const row = await this.db.selectFrom("activities").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toActivity(row) : undefined;
  }

  /**
   * Change fields of an existing activity; fields that are not given stay as they are.
   *
   * @returns The updated activity (undefined when the id does not exist) and how many secrets were masked
   */
  async updateActivity(
    id: number,
    changes: ActivityInput & { type?: string; content?: string }
  ): Promise<{ activity: Activity | undefined; redacted: number }> {
    const safe = changes.content === undefined ? undefined : redactSecrets(changes.content);
    const values = {
      ...(changes.type !== undefined ? { type: changes.type } : {}),
      ...(safe ? { content: safe.text } : {}),
      ...(changes.project !== undefined ? { project: normalizeProject(changes.project) } : {}),
      ...(changes.tags !== undefined ? { tags: JSON.stringify(normalizeTags(changes.tags)) } : {}),
      ...(changes.minutes !== undefined ? { minutes: changes.minutes } : {}),
    };
    if (Object.keys(values).length > 0) {
      await this.db.updateTable("activities").set(values).where("id", "=", id).execute();
    }
    return { activity: await this.getActivity(id), redacted: safe?.count ?? 0 };
  }

  /** Delete one activity; returns false when the id does not exist */
  async deleteActivity(id: number): Promise<boolean> {
    const result = await this.db.deleteFrom("activities").where("id", "=", id).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Get activities for a specific date.
   *
   * `ts` is already stored in local time, so it is compared as-is
   * (no `'localtime'` conversion, which would shift it a second time).
   *
   * @param date - Date string in YYYY-MM-DD format (local timezone)
   * @param filter - Optional project / tag filter
   * @returns Activities recorded on the specified date, ordered by timestamp
   */
  async getActivitiesByDate(date: string, filter: ActivityFilter = {}): Promise<Activity[]> {
    return await this.getActivitiesByRange(date, date, filter);
  }

  /**
   * Get activities between two dates (inclusive).
   *
   * @param from - First date in YYYY-MM-DD format (local timezone)
   * @param to - Last date in YYYY-MM-DD format (local timezone)
   * @param filter - Optional project / tag filter
   */
  async getActivitiesByRange(from: string, to: string, filter: ActivityFilter = {}): Promise<Activity[]> {
    let query = this.db
      .selectFrom("activities")
      .selectAll()
      .where(sql<boolean>`date(ts) >= ${from}`)
      .where(sql<boolean>`date(ts) <= ${to}`);

    const project = normalizeProject(filter.project);
    if (project !== null) {
      query = query.where("project", "=", project);
    }

    const tags = normalizeTags(filter.tags);
    if (tags.length > 0) {
      query = query.where(
        sql<boolean>`EXISTS (
          SELECT 1 FROM json_each(activities.tags)
          WHERE json_each.value IN (${sql.join(tags)})
        )`
      );
    }

    const rows = await query.orderBy("ts", "asc").orderBy("id", "asc").execute();
    return rows.map(toActivity);
  }

  /** Count activities and time spent between two dates, grouped by project, type, tag and day */
  async getStats(from: string, to: string, filter: ActivityFilter = {}): Promise<ActivityStats> {
    const activities = await this.getActivitiesByRange(from, to, filter);
    const groups = { byProject: new Map(), byType: new Map(), byTag: new Map(), byDay: new Map() } satisfies Record<
      string,
      Map<string, StatGroup>
    >;
    const add = (map: Map<string, StatGroup>, name: string, minutes: number): void => {
      const group = map.get(name) ?? { name, count: 0, minutes: 0 };
      group.count += 1;
      group.minutes += minutes;
      map.set(name, group);
    };

    let total = 0;
    for (const activity of activities) {
      const minutes = activity.minutes ?? 0;
      total += minutes;
      add(groups.byProject, activity.project ?? "", minutes);
      add(groups.byType, activity.type, minutes);
      add(groups.byDay, activity.ts.slice(0, 10), minutes);
      for (const tag of activity.tags) add(groups.byTag, tag, minutes);
    }

    const ranked = (map: Map<string, StatGroup>): StatGroup[] =>
      [...map.values()].sort((a, b) => b.minutes - a.minutes || b.count - a.count || a.name.localeCompare(b.name));

    return {
      from,
      to,
      count: activities.length,
      minutes: total,
      byProject: ranked(groups.byProject),
      byType: ranked(groups.byType),
      byTag: ranked(groups.byTag),
      byDay: [...groups.byDay.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * Search activity logs and saved reports, best matches first.
   *
   * Results that contain every word of the query are returned. When nothing
   * contains all of them, results that contain some of the words are returned
   * instead and `partial` is set, so a search with one unlucky word still
   * finds something. Matching is plain substring matching, which also works
   * for short Japanese words that word-based indexes miss.
   */
  async search(query: string, options: { from?: string; to?: string; limit?: number } = {}): Promise<SearchResults> {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((term) => term !== ""))];
    if (terms.length === 0) return { partial: false, activities: [], daily: [], weekly: [], monthly: [] };

    const limit = options.limit ?? 50;
    // Escape LIKE wildcards so the words are matched literally
    const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const anyOf = (...columns: string[]) =>
      sql<boolean>`(${sql.join(
        patterns.flatMap((pattern) => columns.map((column) => sql`${sql.raw(column)} LIKE ${pattern} ESCAPE '\\'`)),
        sql` OR `
      )})`;

    let activityQuery = this.db
      .selectFrom("activities")
      .selectAll()
      .where(anyOf("content", "ifnull(project, '')", "tags"));
    let dailyQuery = this.db.selectFrom("daily_summaries").selectAll().where(anyOf("summary", "ifnull(next_plan, '')"));
    if (options.from) {
      activityQuery = activityQuery.where(sql<boolean>`date(ts) >= ${options.from}`);
      dailyQuery = dailyQuery.where("date", ">=", options.from);
    }
    if (options.to) {
      activityQuery = activityQuery.where(sql<boolean>`date(ts) <= ${options.to}`);
      dailyQuery = dailyQuery.where("date", "<=", options.to);
    }
    const periodRows = async (type: PeriodType): Promise<PeriodSummary[]> => {
      let periodQuery = this.db.selectFrom("period_summaries").selectAll().where("type", "=", type).where(anyOf("summary"));
      if (options.from) periodQuery = periodQuery.where("period_end", ">=", options.from);
      if (options.to) periodQuery = periodQuery.where("period_start", "<=", options.to);
      return (await periodQuery.limit(SEARCH_CANDIDATES).execute()).map((row) => ({ ...row, type }));
    };

    /** Score one result: words found count most, then matches in labels, then how often the words occur */
    const rank = <T>(items: T[], date: (item: T) => string, body: (item: T) => string, labels: (item: T) => string) =>
      items.map((item) => {
        const text = body(item).toLowerCase();
        const label = labels(item).toLowerCase();
        let matched = 0;
        let score = 0;
        for (const term of terms) {
          const occurrences = text.split(term).length - 1;
          const inLabel = label.includes(term);
          if (occurrences === 0 && !inLabel) continue;
          matched += 1;
          score += 10 + Math.min(occurrences, 5) + (inLabel ? 4 : 0);
        }
        return { item, matched, score, date: date(item) };
      });

    const ranked = {
      activities: rank(
        (await activityQuery.limit(SEARCH_CANDIDATES).execute()).map(toActivity),
        (a) => a.ts,
        (a) => a.content,
        (a) => `${a.project ?? ""} ${a.tags.join(" ")}`
      ),
      daily: rank(
        await dailyQuery.limit(SEARCH_CANDIDATES).execute(),
        (d) => d.date,
        (d) => `${d.summary} ${d.next_plan ?? ""}`,
        () => ""
      ),
      weekly: rank(await periodRows("weekly"), (p) => p.period_start, (p) => p.summary, () => ""),
      monthly: rank(await periodRows("monthly"), (p) => p.period_start, (p) => p.summary, () => ""),
    };

    const hasFullMatch = Object.values(ranked).some((group) => group.some((entry) => entry.matched === terms.length));
    const pick = <T>(group: { item: T; matched: number; score: number; date: string }[]): T[] =>
      group
        .filter((entry) => !hasFullMatch || entry.matched === terms.length)
        .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
        .slice(0, limit)
        .map((entry) => entry.item);

    return {
      partial: !hasFullMatch,
      activities: pick(ranked.activities),
      daily: pick(ranked.daily),
      weekly: pick(ranked.weekly),
      monthly: pick(ranked.monthly),
    };
  }

  /** List projects in use with their activity counts, most used first */
  async listProjects(): Promise<LabelCount[]> {
    const rows = await sql<LabelCount>`
      SELECT project AS name, COUNT(*) AS count
      FROM activities
      WHERE project IS NOT NULL AND project <> ''
      GROUP BY project
      ORDER BY count DESC, name ASC
    `.execute(this.db);
    return rows.rows.map((row) => ({ name: row.name, count: Number(row.count) }));
  }

  /** List tags in use with their activity counts, most used first */
  async listTags(): Promise<LabelCount[]> {
    const rows = await sql<LabelCount>`
      SELECT json_each.value AS name, COUNT(*) AS count
      FROM activities, json_each(activities.tags)
      GROUP BY json_each.value
      ORDER BY count DESC, name ASC
    `.execute(this.db);
    return rows.rows.map((row) => ({ name: String(row.name), count: Number(row.count) }));
  }

  /** Delete activities older than specified days (`ts` is stored in local time) */
  async cleanupOldActivities(retentionDays: number): Promise<number> {
    const result = await this.db
      .deleteFrom("activities")
      .where(sql<boolean>`ts < datetime('now', 'localtime', '-' || ${retentionDays} || ' days')`)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  // --- Daily summaries ---

  /**
   * Save or update a daily summary. Secrets are masked before storing.
   *
   * @param nextPlan - What is planned next. `undefined` keeps the stored plan, `null` or "" clears it.
   * @returns How many secrets were masked
   */
  async upsertSummary(date: string, summary: string, nextPlan?: string | null): Promise<{ redacted: number }> {
    const safe = redactSecrets(summary);
    const plan = nextPlan === undefined || nextPlan === null ? undefined : redactSecrets(nextPlan.trim());
    const planValue = nextPlan === undefined ? undefined : plan && plan.text !== "" ? plan.text : null;

    await this.db
      .insertInto("daily_summaries")
      .values({ date, summary: safe.text, next_plan: planValue ?? null })
      .onConflict((oc) =>
        oc.column("date").doUpdateSet({
          summary: safe.text,
          ...(planValue === undefined ? {} : { next_plan: planValue }),
        })
      )
      .execute();
    return { redacted: safe.count + (plan?.count ?? 0) };
  }

  /** Get the most recent daily summary before the given date */
  async getPreviousSummary(beforeDate: string): Promise<DailySummary | undefined> {
    return await this.db
      .selectFrom("daily_summaries")
      .selectAll()
      .where("date", "<", beforeDate)
      .orderBy("date", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  /** Get summaries for the past N months */
  async getSummariesByMonths(months: number): Promise<DailySummary[]> {
    return await this.db
      .selectFrom("daily_summaries")
      .selectAll()
      .where(sql<boolean>`date >= date('now', 'localtime', '-' || ${months} || ' months')`)
      .orderBy("date", "asc")
      .execute();
  }

  /** Get daily summaries between two dates (inclusive); omitted bounds are open */
  async getSummariesByRange(from?: string, to?: string): Promise<DailySummary[]> {
    let query = this.db.selectFrom("daily_summaries").selectAll();
    if (from) query = query.where("date", ">=", from);
    if (to) query = query.where("date", "<=", to);
    return await query.orderBy("date", "asc").execute();
  }

  /** Get summary for a specific date */
  async getSummaryByDate(date: string): Promise<DailySummary | undefined> {
    return await this.db
      .selectFrom("daily_summaries")
      .selectAll()
      .where("date", "=", date)
      .executeTakeFirst();
  }

  // --- Weekly / monthly summaries ---

  /** Save or update a weekly or monthly summary. Secrets are masked before storing. */
  async upsertPeriodSummary(
    type: PeriodType,
    periodStart: string,
    periodEnd: string,
    summary: string
  ): Promise<{ redacted: number }> {
    const safe = redactSecrets(summary);
    await this.db
      .insertInto("period_summaries")
      .values({ type, period_start: periodStart, period_end: periodEnd, summary: safe.text })
      .onConflict((oc) => oc.columns(["type", "period_start"]).doUpdateSet({ period_end: periodEnd, summary: safe.text }))
      .execute();
    return { redacted: safe.count };
  }

  /** Get the weekly or monthly summary that starts on the given date */
  async getPeriodSummary(type: PeriodType, periodStart: string): Promise<PeriodSummary | undefined> {
    const row = await this.db
      .selectFrom("period_summaries")
      .selectAll()
      .where("type", "=", type)
      .where("period_start", "=", periodStart)
      .executeTakeFirst();
    return row ? { ...row, type } : undefined;
  }

  /** Get weekly or monthly summaries that overlap the given range; omitted bounds are open */
  async getPeriodSummariesByRange(type: PeriodType, from?: string, to?: string): Promise<PeriodSummary[]> {
    let query = this.db.selectFrom("period_summaries").selectAll().where("type", "=", type);
    if (from) query = query.where("period_end", ">=", from);
    if (to) query = query.where("period_start", "<=", to);
    const rows = await query.orderBy("period_start", "asc").execute();
    return rows.map((row) => ({ ...row, type }));
  }

  /** Get weekly or monthly summaries for the past N months */
  async getPeriodSummariesByMonths(type: PeriodType, months: number): Promise<PeriodSummary[]> {
    const rows = await this.db
      .selectFrom("period_summaries")
      .selectAll()
      .where("type", "=", type)
      .where(sql<boolean>`period_end >= date('now', 'localtime', '-' || ${months} || ' months')`)
      .orderBy("period_start", "asc")
      .execute();
    return rows.map((row) => ({ ...row, type }));
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
    const value = Number.parseInt((await this.getConfig("retention_days")) ?? "", 10);
    return Number.isNaN(value) ? 30 : value;
  }

  /** Get default (daily) template */
  async getDefaultTemplate(): Promise<string> {
    return (await this.getConfig("default_template")) ?? "";
  }

  /** Get the template for a weekly or monthly report */
  async getPeriodTemplate(type: PeriodType): Promise<string> {
    return (await this.getConfig(type === "weekly" ? "weekly_template" : "monthly_template")) ?? "";
  }

  /** Get the first day of the week used for weekly reports */
  async getWeekStart(): Promise<WeekStart> {
    return (await this.getConfig("week_start")) === "sunday" ? "sunday" : "monday";
  }

  // --- Internal state ---

  /** Read a value Remem keeps for itself (not a user setting) */
  async getState(key: string): Promise<string | undefined> {
    const row = await this.db.selectFrom("config").select("value").where("key", "=", `state:${key}`).executeTakeFirst();
    return row?.value;
  }

  /** Store a value Remem keeps for itself (not a user setting) */
  async setState(key: string, value: string): Promise<void> {
    await this.db
      .insertInto("config")
      .values({ key: `state:${key}`, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
      .execute();
  }

  // --- Lifecycle ---

  /** Close the database connection */
  async close(): Promise<void> {
    await this.db.destroy();
  }
}
