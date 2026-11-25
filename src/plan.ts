/**
 * "What I said I would do next": taken from the plan saved with a daily
 * report, or, for reports without one, from the report's own "next" section.
 */

import type { TFunction } from "i18next";

import type { RememDatabase } from "./database.js";
import type { DailySummary } from "./schema.js";
import { addDays } from "./utils.js";

/** Headings that introduce planned work */
const PLAN_HEADING =
  /(明日|翌日|翌営業日|次回|来週|今後|次).{0,4}(予定|タスク|計画|やること|作業)|^(次|予定|todo|to-do)$|next\s*(steps?|day|actions?|up)?$|tomorrow|plan(s|ned)?\b|to[- ]?do/i;

/** A plan older than this is no longer shown as a reminder */
const MAX_AGE_DAYS = 14;

/** Config table key remembering the day the reminder was last shown */
const STATE_KEY = "last_briefing_date";

/** Find the "next" section of a Markdown report; null when there is none */
export function extractPlan(markdown: string): string | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;

  for (let index = 0; index < lines.length; index++) {
    if (/^\s*(```|~~~)/.test(lines[index])) inFence = !inFence;
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[index]);
    if (!heading) continue;
    // Ignore emoji and symbols in front of the title
    const title = heading[2].replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (!PLAN_HEADING.test(title)) continue;

    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const following = /^(#{1,6})\s/.exec(lines[next]);
      if (following && following[1].length <= heading[1].length) break;
      body.push(lines[next]);
    }
    const text = body.join("\n").trim();
    if (text !== "") return text;
  }
  return null;
}

/** The plan of a saved daily report: the stored one, otherwise its "next" section */
export function planOf(summary: DailySummary): string | null {
  const stored = summary.next_plan?.trim() ?? "";
  return stored !== "" ? stored : extractPlan(summary.summary);
}

export interface Briefing {
  /** Date of the report the plan comes from */
  date: string;
  plan: string;
}

/** The most recent plan made before `today`, if it is recent enough to matter */
export async function getBriefing(db: RememDatabase, today: string): Promise<Briefing | null> {
  const previous = await db.getPreviousSummary(today);
  if (!previous || previous.date < addDays(today, -MAX_AGE_DAYS)) return null;
  const plan = planOf(previous);
  return plan ? { date: previous.date, plan } : null;
}

export function formatBriefing(briefing: Briefing, t: TFunction): string {
  return t("briefing.reminder", { date: briefing.date, plan: briefing.plan });
}

/**
 * Return the reminder once per day: the first call on a new day gets it,
 * later calls on the same day get null.
 */
export async function takeDailyBriefing(db: RememDatabase, today: string): Promise<Briefing | null> {
  if ((await db.getState(STATE_KEY)) === today) return null;
  await db.setState(STATE_KEY, today);
  return await getBriefing(db, today);
}
