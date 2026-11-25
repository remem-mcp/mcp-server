/**
 * Kysely database schema types and shared domain types
 */

import type { Generated, Selectable } from "kysely";

/** Activity types that can be logged */
export const ACTIVITY_TYPES = ["work", "decision", "memo", "approval"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Period summary types */
export const PERIOD_TYPES = ["weekly", "monthly"] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];

/** Summary types (daily plus period summaries) */
export const SUMMARY_TYPES = ["daily", "weekly", "monthly"] as const;
export type SummaryType = (typeof SUMMARY_TYPES)[number];

/** First day of the week used for weekly reports */
export const WEEK_STARTS = ["monday", "sunday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

/** Configuration keys stored in the database */
export const CONFIG_KEYS = [
  "retention_days",
  "default_template",
  "weekly_template",
  "monthly_template",
  "week_start",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Activities table schema */
export interface ActivitiesTable {
  id: Generated<number>;
  ts: Generated<string>;
  type: string;
  content: string;
  /** Optional project name used to group activities */
  project: string | null;
  /** JSON array of tag strings */
  tags: Generated<string>;
  /** Time spent, in minutes */
  minutes: number | null;
  /** Origin of an imported entry (e.g. "git:<hash>"); unique, so it is imported once */
  source: string | null;
}

/** Daily summaries table schema */
export interface DailySummariesTable {
  date: string;
  summary: string;
  /** What the user plans to do next, shown as a reminder on the following day */
  next_plan: string | null;
}

/** Weekly / monthly summaries table schema */
export interface PeriodSummariesTable {
  type: string;
  period_start: string;
  period_end: string;
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
  period_summaries: PeriodSummariesTable;
  config: ConfigTable;
}

/** Activity as returned to callers (tags decoded into an array) */
export interface Activity {
  id: number;
  ts: string;
  type: string;
  content: string;
  project: string | null;
  tags: string[];
  /** Time spent, in minutes */
  minutes: number | null;
}

/** Fields of an activity that can be set when logging or editing */
export interface ActivityInput {
  project?: string | null;
  tags?: readonly string[];
  minutes?: number | null;
}

/** Activity counts and time for one group (project, type, tag or day) */
export interface StatGroup {
  name: string;
  count: number;
  minutes: number;
}

export interface ActivityStats {
  from: string;
  to: string;
  count: number;
  minutes: number;
  byProject: StatGroup[];
  byType: StatGroup[];
  byTag: StatGroup[];
  byDay: StatGroup[];
}

export interface SearchResults {
  /** True when nothing contained every word, so results containing some of the words are returned */
  partial: boolean;
  activities: Activity[];
  daily: DailySummary[];
  weekly: PeriodSummary[];
  monthly: PeriodSummary[];
}

export type DailySummary = Selectable<DailySummariesTable>;

export interface PeriodSummary {
  type: PeriodType;
  period_start: string;
  period_end: string;
  summary: string;
}

/** Optional filters when reading activities */
export interface ActivityFilter {
  /** Only activities that belong to this project */
  project?: string;
  /** Only activities that have at least one of these tags */
  tags?: readonly string[];
}

/** A label (project or tag) with the number of activities using it */
export interface LabelCount {
  name: string;
  count: number;
}
