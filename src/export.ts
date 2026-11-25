/**
 * Export of saved reports (and optionally activity logs) to Markdown or JSON
 */

import type { TFunction } from "i18next";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RememDatabase } from "./database.js";
import { markdownToPlainText } from "./plaintext.js";
import type { Activity, DailySummary, PeriodSummary, SummaryType } from "./schema.js";
import { formatLocalTimestamp, formatMinutes } from "./utils.js";

export const EXPORT_FORMATS = ["markdown", "text", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_TYPES = ["all", "daily", "weekly", "monthly"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export interface ExportOptions {
  /** Which reports to include (default: all) */
  type?: ExportType;
  /** First date to include, YYYY-MM-DD (default: no lower bound) */
  from?: string;
  /** Last date to include, YYYY-MM-DD (default: no upper bound) */
  to?: string;
  /** Output format (default: markdown) */
  format?: ExportFormat;
  /** Also include raw activity logs that are still retained */
  includeLogs?: boolean;
}

export interface ExportData {
  generated_at: string;
  from: string | null;
  to: string | null;
  daily: DailySummary[];
  weekly: PeriodSummary[];
  monthly: PeriodSummary[];
  activities?: Activity[];
}

export interface ExportResult {
  content: string;
  filename: string;
  mimeType: string;
  /** Number of reports (daily + weekly + monthly) included */
  count: number;
  data: ExportData;
}

/** Collect everything that matches the export options */
export async function collectExportData(db: RememDatabase, options: ExportOptions = {}): Promise<ExportData> {
  const type: ExportType = options.type ?? "all";
  const includes = (candidate: SummaryType): boolean => type === "all" || type === candidate;

  const data: ExportData = {
    generated_at: formatLocalTimestamp(),
    from: options.from ?? null,
    to: options.to ?? null,
    daily: includes("daily") ? await db.getSummariesByRange(options.from, options.to) : [],
    weekly: includes("weekly") ? await db.getPeriodSummariesByRange("weekly", options.from, options.to) : [],
    monthly: includes("monthly") ? await db.getPeriodSummariesByRange("monthly", options.from, options.to) : [],
  };

  if (options.includeLogs) {
    data.activities = await db.getActivitiesByRange(options.from ?? "0000-01-01", options.to ?? "9999-12-31");
  }

  return data;
}

/**
 * Lower the level of Markdown headings so that an embedded report nests
 * under the export's own headings. Lines inside fenced code blocks are kept.
 */
export function demoteHeadings(markdown: string, levels: number): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = /^(#{1,6})(\s.*)$/.exec(line);
      if (!match) return line;
      return "#".repeat(Math.min(6, match[1].length + levels)) + match[2];
    })
    .join("\n");
}

/** Render one activity as a Markdown list item */
function renderActivity(activity: Activity): string {
  const project = activity.project ? ` (${activity.project})` : "";
  const tags = activity.tags.map((tag) => ` #${tag}`).join("");
  const content = activity.content.replace(/\s*\n\s*/g, " ");
  const time = activity.minutes ? ` [${formatMinutes(activity.minutes)}]` : "";
  return `- ${activity.ts} [${activity.type}]${project} ${content}${tags}${time}`;
}

/** Render export data as a single Markdown document */
export function renderMarkdown(data: ExportData, t: TFunction): string {
  const lines: string[] = [`# ${t("export.title")}`, "", `- ${t("export.generatedAt", { timestamp: data.generated_at })}`];
  lines.push(
    data.from || data.to
      ? `- ${t("export.range", { from: data.from ?? "…", to: data.to ?? "…" })}`
      : `- ${t("export.rangeAll")}`
  );

  const section = (title: string, entries: { heading: string; body: string }[]): void => {
    if (entries.length === 0) return;
    lines.push("", `## ${title}`);
    for (const entry of entries) {
      lines.push("", `### ${entry.heading}`, "", demoteHeadings(entry.body.trim(), 3));
    }
  };

  section(
    t("export.dailyHeader"),
    data.daily.map((row) => ({ heading: row.date, body: row.summary }))
  );
  for (const type of ["weekly", "monthly"] as const) {
    section(
      t(`export.${type}Header`),
      data[type].map((row) => ({ heading: `${row.period_start} – ${row.period_end}`, body: row.summary }))
    );
  }

  if (data.activities && data.activities.length > 0) {
    lines.push("", `## ${t("export.logsHeader")}`, "", ...data.activities.map(renderActivity));
  }

  return `${lines.join("\n")}\n`;
}

/** Build the export content and a suggested file name */
export async function buildExport(db: RememDatabase, options: ExportOptions, t: TFunction): Promise<ExportResult> {
  const data = await collectExportData(db, options);
  const format: ExportFormat = options.format ?? "markdown";
  const stamp = data.generated_at.replace(/[-:]/g, "").replace(" ", "-");

  const markdown = (): string => renderMarkdown(data, t);
  const outputs: Record<ExportFormat, { content: () => string; extension: string; mimeType: string }> = {
    markdown: { content: markdown, extension: "md", mimeType: "text/markdown; charset=utf-8" },
    // Plain text reads well when pasted into chat tools or e-mail
    text: { content: () => `${markdownToPlainText(markdown())}\n`, extension: "txt", mimeType: "text/plain; charset=utf-8" },
    json: { content: () => `${JSON.stringify(data, null, 2)}\n`, extension: "json", mimeType: "application/json; charset=utf-8" },
  };
  const output = outputs[format];

  return {
    content: output.content(),
    filename: `remem-export-${stamp}.${output.extension}`,
    mimeType: output.mimeType,
    count: data.daily.length + data.weekly.length + data.monthly.length,
    data,
  };
}

/** Write an export into `<data dir>/exports` and return the full path */
export function writeExportFile(dataPath: string, filename: string, content: string): string {
  const directory = join(dataPath, "exports");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, content, "utf8");
  return path;
}
