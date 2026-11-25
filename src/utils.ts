/**
 * Date and tag helpers.
 *
 * All dates are handled in the user's local timezone and exchanged as
 * `YYYY-MM-DD` strings, matching how timestamps are stored in the database.
 */

import type { PeriodType, WeekStart } from "./schema.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format a date object to local timestamp string in YYYY-MM-DD HH:MM:SS format
 */
export function formatLocalTimestamp(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${formatLocalDate(date)} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format a date object to local date string in YYYY-MM-DD format
 */
export function formatLocalDate(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Check that a string is a real calendar date in YYYY-MM-DD format (rejects e.g. 2026-13-45) */
export function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Parse a YYYY-MM-DD string as a UTC-midnight date (used only for calendar arithmetic) */
function toUtcDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Add (or subtract) calendar days to a YYYY-MM-DD string */
export function addDays(value: string, days: number): string {
  const date = toUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtcDate(date);
}

/** Add (or subtract) calendar months to a YYYY-MM-DD string, clamping to the end of the month */
export function addMonths(value: string, months: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fromUtcDate(target);
}

/** Inclusive date range of a week or month */
export interface PeriodRange {
  start: string;
  end: string;
}

/**
 * Get the week or month that contains the given date.
 *
 * @param type - "weekly" or "monthly"
 * @param date - Any date inside the period (YYYY-MM-DD)
 * @param weekStart - First day of the week (only used for "weekly")
 */
export function getPeriodRange(type: PeriodType, date: string, weekStart: WeekStart = "monday"): PeriodRange {
  if (type === "monthly") {
    const [year, month] = date.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      start: `${date.slice(0, 7)}-01`,
      end: `${date.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  const dayOfWeek = toUtcDate(date).getUTCDay(); // 0 = Sunday
  const offset = weekStart === "sunday" ? dayOfWeek : (dayOfWeek + 6) % 7;
  const start = addDays(date, -offset);
  return { start, end: addDays(start, 6) };
}

/** Maximum length of a single tag or project name */
export const MAX_LABEL_LENGTH = 50;

/** Normalize a project name: trimmed, or null when empty */
export function normalizeProject(project: string | null | undefined): string | null {
  const trimmed = project?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Normalize tags: trim, drop a leading "#", remove empties and duplicates */
export function normalizeTags(tags: readonly string[] | null | undefined): string[] {
  const result: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.trim().replace(/^#+/, "").trim();
    if (tag !== "" && !result.includes(tag)) result.push(tag);
  }
  return result;
}

/** Format a number of minutes as hours and minutes, e.g. 95 -> "1h 35m" */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
