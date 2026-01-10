/**
 * Kysely database schema types
 */

import type { Generated, Insertable, Selectable, Updateable } from "kysely";

/** Activities table schema */
export interface ActivitiesTable {
  id: Generated<number>;
  ts: Generated<string>;
  type: string;
  content: string;
}

/** Daily summaries table schema */
export interface DailySummariesTable {
  date: string;
  summary: string;
}

/** Config table schema */
export interface ConfigTable {
  key: string;
  value: string;
}

/** Complete database schema */
export interface Database {
  activities: ActivitiesTable;
  daily_summaries: DailySummariesTable;
  config: ConfigTable;
}

// Type helpers for each table
export type Activity = Selectable<ActivitiesTable>;
export type NewActivity = Insertable<ActivitiesTable>;
export type ActivityUpdate = Updateable<ActivitiesTable>;

export type DailySummary = Selectable<DailySummariesTable>;
export type NewDailySummary = Insertable<DailySummariesTable>;

export type Config = Selectable<ConfigTable>;
export type NewConfig = Insertable<ConfigTable>;

/** Activity types that can be logged */
export type ActivityType = "work" | "decision" | "memo" | "approval";

/** Configuration keys stored in the database */
export type ConfigKey = "retention_days" | "default_template";
