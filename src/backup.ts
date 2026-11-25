/**
 * Full backup and restore of the Remem database as a JSON file,
 * for moving to another computer or keeping a safety copy.
 */

import { readFileSync } from "node:fs";

import type { RememDatabase } from "./database.js";
import { ACTIVITY_TYPES, CONFIG_KEYS, PERIOD_TYPES, type Activity, type DailySummary, type PeriodSummary } from "./schema.js";
import { formatLocalTimestamp, isValidCalendarDate } from "./utils.js";

export const BACKUP_FORMAT = "remem-backup";
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  created_at: string;
  activities: Activity[];
  daily: DailySummary[];
  weekly: PeriodSummary[];
  monthly: PeriodSummary[];
  config: Record<string, string>;
}

export interface RestoreResult {
  activities: number;
  summaries: number;
  /** Entries that already existed and were left untouched */
  skipped: number;
}

/** Collect everything stored in the database */
export async function createBackup(db: RememDatabase): Promise<Backup> {
  const config: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const value = await db.getConfig(key);
    if (value !== undefined) config[key] = value;
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at: formatLocalTimestamp(),
    activities: await db.getActivitiesByRange("0000-01-01", "9999-12-31"),
    daily: await db.getSummariesByRange(),
    weekly: await db.getPeriodSummariesByRange("weekly"),
    monthly: await db.getPeriodSummariesByRange("monthly"),
    config,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Read and check a backup file */
export function readBackupFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Could not read a JSON backup from ${path}`);
  }
  if (!isRecord(parsed) || parsed.format !== BACKUP_FORMAT) {
    throw new Error("This file is not a Remem backup");
  }
  if (typeof parsed.version !== "number" || parsed.version > BACKUP_VERSION) {
    throw new Error("This backup was made by a newer version of Remem");
  }
  return parsed;
}

/**
 * Merge a backup into the database. Existing reports and identical log
 * entries are kept as they are, so restoring twice does not duplicate data.
 *
 * @param overwrite - Replace existing reports with the ones from the backup
 */
export async function restoreBackup(
  db: RememDatabase,
  backup: Record<string, unknown>,
  options: { overwrite?: boolean } = {}
): Promise<RestoreResult> {
  const result: RestoreResult = { activities: 0, summaries: 0, skipped: 0 };

  const existing = new Set(
    (await db.getActivitiesByRange("0000-01-01", "9999-12-31")).map((a) => `${a.ts}\u0000${a.type}\u0000${a.content}`)
  );
  for (const row of list(backup.activities)) {
    const { ts, type, content } = row;
    if (typeof ts !== "string" || typeof content !== "string" || !(ACTIVITY_TYPES as readonly unknown[]).includes(type)) continue;
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) continue;
    const key = `${ts}\u0000${String(type)}\u0000${content}`;
    if (existing.has(key)) {
      result.skipped += 1;
      continue;
    }
    existing.add(key);
    await db.insertActivity(String(type), content, {
      timestamp: ts,
      project: typeof row.project === "string" ? row.project : null,
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
      minutes: typeof row.minutes === "number" && Number.isInteger(row.minutes) && row.minutes >= 0 ? row.minutes : null,
    });
    result.activities += 1;
  }

  for (const row of list(backup.daily)) {
    const { date, summary } = row;
    if (typeof date !== "string" || !isValidCalendarDate(date) || typeof summary !== "string" || summary.trim() === "") continue;
    if (!options.overwrite && (await db.getSummaryByDate(date))) {
      result.skipped += 1;
      continue;
    }
    await db.upsertSummary(date, summary, typeof row.next_plan === "string" ? row.next_plan : null);
    result.summaries += 1;
  }

  for (const type of PERIOD_TYPES) {
    for (const row of list(backup[type])) {
      const { period_start: start, period_end: end, summary } = row;
      if (typeof start !== "string" || typeof end !== "string" || typeof summary !== "string" || summary.trim() === "") continue;
      if (!isValidCalendarDate(start) || !isValidCalendarDate(end)) continue;
      if (!options.overwrite && (await db.getPeriodSummary(type, start))) {
        result.skipped += 1;
        continue;
      }
      await db.upsertPeriodSummary(type, start, end, summary);
      result.summaries += 1;
    }
  }

  return result;
}
