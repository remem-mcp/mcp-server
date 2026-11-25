/**
 * MCP Tool definitions for Remem
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TFunction } from "i18next";
import { z } from "zod";

import type { RememDatabase } from "./database.js";
import { buildExport, EXPORT_FORMATS, EXPORT_TYPES, writeExportFile } from "./export.js";
import { importGitCommits } from "./git.js";
import { formatBriefing, getBriefing, takeDailyBriefing } from "./plan.js";
import { markdownToPlainText } from "./plaintext.js";
import { ACTIVITY_TYPES, CONFIG_KEYS, PERIOD_TYPES, SUMMARY_TYPES, WEEK_STARTS, type ActivityFilter } from "./schema.js";
import {
  formatLocalDate,
  formatLocalTimestamp,
  formatMinutes,
  getPeriodRange,
  isValidCalendarDate,
  MAX_LABEL_LENGTH,
  normalizeProject,
  normalizeTags,
} from "./utils.js";

/** Date string in YYYY-MM-DD format */
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .refine(isValidCalendarDate, "Date must be a valid calendar date")
  .describe("Date in YYYY-MM-DD format");

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:MM format (24-hour)");
const ProjectSchema = z.string().trim().min(1).max(MAX_LABEL_LENGTH);
const TagsSchema = z.array(z.string().trim().min(1).max(MAX_LABEL_LENGTH)).max(20);
const MinutesSchema = z.number().int().min(1).max(1440);
const PeriodSchema = z.enum(PERIOD_TYPES);
const IdSchema = z.number().int().positive();

// --- Structured output shapes (returned next to the text for clients that read data) ---

const ActivityShape = z.object({
  id: z.number(),
  ts: z.string(),
  type: z.string(),
  content: z.string(),
  project: z.string().nullable(),
  tags: z.array(z.string()),
  minutes: z.number().nullable(),
});
const DailyShape = z.object({ date: z.string(), summary: z.string(), next_plan: z.string().nullable() });
const PeriodShape = z.object({ type: z.string(), period_start: z.string(), period_end: z.string(), summary: z.string() });
const GroupShape = z.object({ name: z.string(), count: z.number(), minutes: z.number() });
const LabelShape = z.object({ name: z.string(), count: z.number() });

/** Things `open_dashboard` needs from the host process */
export interface ToolContext {
  /** Start the web dashboard (or return the one already running) and give its URL */
  openDashboard?: () => Promise<string>;
}

type TextContent = { type: "text"; text: string };

interface ToolResult {
  [key: string]: unknown;
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const text = (value: string): TextContent => ({ type: "text", text: value });

/**
 * Register all MCP tools
 */
export function registerTools(server: McpServer, db: RememDatabase, t: TFunction, context: ToolContext = {}): void {
  /**
   * Wrap a tool so that the first successful call of a new day also returns
   * what the user planned in their previous daily report.
   */
  const daily =
    <P extends unknown[]>(handler: (...args: P) => Promise<ToolResult>) =>
    async (...args: P): Promise<ToolResult> => {
      const result = await handler(...args);
      if (result.isError) return result;
      const briefing = await takeDailyBriefing(db, formatLocalDate());
      return briefing ? { ...result, content: [...result.content, text(formatBriefing(briefing, t))] } : result;
    };

  /** Describe an active project / tag filter, or nothing when unfiltered */
  const describeFilter = (filter: ActivityFilter): TextContent[] => {
    const lines: string[] = [];
    if (filter.project) lines.push(t("report.filterProject", { project: filter.project }));
    if (filter.tags && filter.tags.length > 0) lines.push(t("report.filterTags", { tags: filter.tags.join(", ") }));
    return lines.length > 0 ? [text(`${t("report.filterHeader")}\n${lines.join("\n")}`)] : [];
  };

  /** Tell the model (and so the user) that credentials were removed */
  const redactionNotice = (count: number): TextContent[] => (count > 0 ? [text(t("redact.notice", { count }))] : []);

  // --- log: Record an activity ---
  server.registerTool(
    "log",
    {
      title: "Log activity",
      description:
        "Record one activity in the user's work journal: finished work, a decision and its reason, a memo, or an approval. Call it whenever a meaningful unit of work is done, without waiting to be asked. Classify it with a project and tags (reuse names from list_tags) and add the time spent when known.",
      inputSchema: {
        type: z.enum(ACTIVITY_TYPES).describe("Type of activity"),
        content: z
          .string()
          .min(1)
          .describe("What happened, written so it is understandable later on its own (include the PR, ticket or file name when there is one)"),
        project: ProjectSchema.optional().describe("Project this activity belongs to (use list_tags to see existing names)"),
        tags: TagsSchema.optional().describe("Tags for finer classification, e.g. [\"review\", \"frontend\"]"),
        minutes: MinutesSchema.optional().describe("Time spent in minutes, when known"),
        date: DateSchema.optional().describe("Date the activity happened, to record it afterwards (defaults to today). Logs older than retention_days are removed when a report is prepared."),
        time: TimeSchema.optional().describe("Time of day the activity happened, HH:MM (defaults to now)"),
      },
      outputSchema: { id: z.number().nullable(), ts: z.string(), redacted: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    daily(async ({ type, content, project, tags, minutes, date, time }) => {
      const now = formatLocalTimestamp();
      const day = date ?? now.slice(0, 10);
      // A past day without a time is filed at noon, so it sorts in the middle of that day
      const clock = time ? `${time}:00` : day === now.slice(0, 10) ? now.slice(11) : "12:00:00";
      const ts = `${day} ${clock}`;

      const result = await db.insertActivity(type, content, { project, tags, minutes, timestamp: ts });
      return {
        content: [text(t("log.success", { type })), ...redactionNotice(result.redacted)],
        structuredContent: { id: result.id, ts, redacted: result.redacted },
      };
    })
  );

  // --- update_log: Correct an activity ---
  server.registerTool(
    "update_log",
    {
      title: "Update a log entry",
      description:
        "Correct an existing log entry (find its id with search or prepare_report). Only the fields you pass are changed.",
      inputSchema: {
        id: IdSchema.describe("Id of the log entry"),
        type: z.enum(ACTIVITY_TYPES).optional().describe("New type"),
        content: z.string().min(1).optional().describe("New content"),
        project: z.string().trim().max(MAX_LABEL_LENGTH).optional().describe("New project; an empty string removes the project"),
        tags: TagsSchema.optional().describe("New tags (replaces all tags; an empty list removes them)"),
        minutes: z.number().int().min(0).max(1440).optional().describe("New time spent in minutes; 0 removes it"),
      },
      outputSchema: { activity: ActivityShape, redacted: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    daily(async ({ id, type, content, project, tags, minutes }) => {
      const result = await db.updateActivity(id, {
        type,
        content,
        project,
        tags,
        minutes: minutes === undefined ? undefined : minutes === 0 ? null : minutes,
      });
      if (!result.activity) return { isError: true, content: [text(t("log.notFound", { id }))] };
      return {
        content: [text(`${t("log.updated", { id })}\n${JSON.stringify(result.activity, null, 2)}`), ...redactionNotice(result.redacted)],
        structuredContent: { activity: result.activity, redacted: result.redacted },
      };
    })
  );

  // --- delete_log: Remove an activity ---
  server.registerTool(
    "delete_log",
    {
      title: "Delete a log entry",
      description: "Permanently delete one log entry, for example one that was recorded by mistake. This cannot be undone.",
      inputSchema: { id: IdSchema.describe("Id of the log entry") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    daily(async ({ id }) =>
      (await db.deleteActivity(id))
        ? { content: [text(t("log.deleted", { id }))] }
        : { isError: true, content: [text(t("log.notFound", { id }))] }
    )
  );

  // --- prepare_report: Gather data for report generation ---
  server.registerTool(
    "prepare_report",
    {
      title: "Prepare daily report",
      description:
        "Step 1 of a daily report: returns the day's logs, time spent, the previous day's plan, the report template and the target language. Write the report from them, then store it with save_summary. Can be limited to one project or to tags. Also removes logs older than retention_days.",
      inputSchema: {
        date: DateSchema.optional().describe("Target date (defaults to today)"),
        project: ProjectSchema.optional().describe("Only include logs of this project"),
        tags: TagsSchema.optional().describe("Only include logs that have at least one of these tags"),
        custom_instruction: z.string().optional().describe("Additional instructions for the AI"),
      },
      outputSchema: {
        date: z.string(),
        logs: z.array(ActivityShape),
        total_minutes: z.number(),
        template: z.string(),
        language: z.string(),
        existing_summary: z.string().nullable(),
        previous_plan: z.object({ date: z.string(), plan: z.string() }).nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    daily(async ({ date, project, tags, custom_instruction }) => {
      const targetDate = date ?? formatLocalDate();
      const filter: ActivityFilter = { project: normalizeProject(project) ?? undefined, tags: normalizeTags(tags) };
      const logs = await db.getActivitiesByDate(targetDate, filter);
      const template = await db.getDefaultTemplate();
      const existingSummary = await db.getSummaryByDate(targetDate);
      const previousPlan = await getBriefing(db, targetDate);
      const totalMinutes = logs.reduce((sum, log) => sum + (log.minutes ?? 0), 0);

      // Cleanup old activities
      const retentionDays = await db.getRetentionDays();
      const deletedCount = await db.cleanupOldActivities(retentionDays);

      const structuredContent = {
        date: targetDate,
        logs,
        total_minutes: totalMinutes,
        template,
        language: t("language.name"),
        existing_summary: existingSummary?.summary ?? null,
        previous_plan: previousPlan,
      };

      if (logs.length === 0) {
        return {
          content: [text(t("report.noLogs")), text(t("report.date", { date: targetDate })), ...describeFilter(filter)],
          structuredContent,
        };
      }

      return {
        content: [
          text(t("report.title", { date: targetDate })),
          ...describeFilter(filter),
          text(`${t("report.logsHeader", { count: logs.length })}\n${JSON.stringify(logs, null, 2)}`),
          ...(totalMinutes > 0 ? [text(t("report.totalTime", { time: formatMinutes(totalMinutes) }))] : []),
          ...(previousPlan ? [text(`${t("report.previousPlanHeader", { date: previousPlan.date })}\n${previousPlan.plan}`)] : []),
          text(`${t("report.templateHeader")}\n${template}`),
          text(t("report.languageHeader", { language: t("language.name") })),
          ...(existingSummary ? [text(`${t("report.existingSummaryHeader")}\n${existingSummary.summary}`)] : []),
          ...(custom_instruction ? [text(`${t("report.instructionsHeader")}\n${custom_instruction}`)] : []),
          text(t("report.nextStep", { date: targetDate })),
          ...(deletedCount > 0 ? [text(t("report.cleanedUp", { count: deletedCount }))] : []),
        ],
        structuredContent,
      };
    })
  );

  // --- save_summary: Persist the generated summary ---
  server.registerTool(
    "save_summary",
    {
      title: "Save daily summary",
      description:
        "Step 2 of a daily report: store the written report for a date in long-term storage. Saving again for the same date replaces the earlier report. Pass next_plan so the user is reminded of it on their next working day.",
      inputSchema: {
        date: DateSchema.describe("Date of the summary"),
        summary: z.string().min(1).describe("Summarized report content"),
        next_plan: z
          .string()
          .optional()
          .describe("What the user plans to do next (a short list); shown as a reminder the next day Remem is used"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    daily(async ({ date, summary, next_plan }) => {
      const result = await db.upsertSummary(date, summary, next_plan);
      return { content: [text(t("summary.saved")), ...redactionNotice(result.redacted)] };
    })
  );

  // --- prepare_period_report: Gather data for a weekly / monthly report ---
  server.registerTool(
    "prepare_period_report",
    {
      title: "Prepare weekly or monthly report",
      description:
        "Step 1 of a weekly or monthly report: returns the daily summaries of the week or month (plus raw logs for days without a summary), time spent per project, the template and the target language. Write the report from them, then store it with save_period_summary.",
      inputSchema: {
        period: PeriodSchema.describe("Report period: weekly or monthly"),
        date: DateSchema.optional().describe("Any date inside the target week or month (defaults to today)"),
        custom_instruction: z.string().optional().describe("Additional instructions for the AI"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    daily(async ({ period, date, custom_instruction }) => {
      const range = getPeriodRange(period, date ?? formatLocalDate(), await db.getWeekStart());
      const summaries = await db.getSummariesByRange(range.start, range.end);
      const summarizedDates = new Set(summaries.map((row) => row.date));
      const logs = (await db.getActivitiesByRange(range.start, range.end)).filter(
        (activity) => !summarizedDates.has(activity.ts.slice(0, 10))
      );
      const labels = { type: t(`period.${period}`), start: range.start, end: range.end };

      if (summaries.length === 0 && logs.length === 0) {
        return { content: [text(t("period.noData", labels))] };
      }

      const stats = await db.getStats(range.start, range.end);
      const timeByProject = stats.byProject
        .filter((group) => group.minutes > 0)
        .map((group) => `- ${group.name || t("stats.noProject")}: ${formatMinutes(group.minutes)}`);

      const existing = await db.getPeriodSummary(period, range.start);
      return {
        content: [
          text(t("period.title", labels)),
          text(
            `${t("period.dailySummariesHeader", { count: summaries.length })}\n${JSON.stringify(
              summaries.map((row) => ({ date: row.date, summary: row.summary })),
              null,
              2
            )}`
          ),
          ...(logs.length > 0
            ? [text(`${t("period.logsHeader", { count: logs.length })}\n${JSON.stringify(logs, null, 2)}`)]
            : []),
          ...(timeByProject.length > 0
            ? [text(`${t("stats.timeByProjectHeader", { time: formatMinutes(stats.minutes) })}\n${timeByProject.join("\n")}`)]
            : []),
          text(`${t("report.templateHeader")}\n${await db.getPeriodTemplate(period)}`),
          text(t("report.languageHeader", { language: t("language.name") })),
          ...(existing ? [text(`${t("report.existingSummaryHeader")}\n${existing.summary}`)] : []),
          ...(custom_instruction ? [text(`${t("report.instructionsHeader")}\n${custom_instruction}`)] : []),
          text(t("period.nextStep", { period, start: range.start })),
        ],
      };
    })
  );

  // --- save_period_summary: Persist a weekly / monthly summary ---
  server.registerTool(
    "save_period_summary",
    {
      title: "Save weekly or monthly summary",
      description:
        "Step 2 of a weekly or monthly report: store the written report in long-term storage. Saving again for the same week or month replaces the earlier report.",
      inputSchema: {
        period: PeriodSchema.describe("Report period: weekly or monthly"),
        date: DateSchema.describe("Any date inside the week or month the summary covers"),
        summary: z.string().min(1).describe("Weekly or monthly report content"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    daily(async ({ period, date, summary }) => {
      const range = getPeriodRange(period, date, await db.getWeekStart());
      const result = await db.upsertPeriodSummary(period, range.start, range.end, summary);
      return {
        content: [
          text(t("period.saved", { type: t(`period.${period}`), start: range.start, end: range.end })),
          ...redactionNotice(result.redacted),
        ],
      };
    })
  );

  // --- get_report: Read one saved report ---
  server.registerTool(
    "get_report",
    {
      title: "Get a saved report",
      description:
        "Read one saved daily, weekly or monthly report. Use format \"text\" to get plain text that can be pasted into chat or e-mail, where Markdown is not rendered.",
      inputSchema: {
        type: z.enum(SUMMARY_TYPES).optional().describe("Which report (default: daily)"),
        date: DateSchema.optional().describe("The day, or any date inside the week or month (defaults to today)"),
        format: z.enum(["markdown", "text"]).optional().describe("Output format (default: markdown)"),
      },
      outputSchema: {
        type: z.string(),
        start: z.string(),
        end: z.string(),
        found: z.boolean(),
        content: z.string().nullable(),
        next_plan: z.string().nullable(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    daily(async ({ type, date, format }) => {
      const kind = type ?? "daily";
      const day = date ?? formatLocalDate();
      const range = kind === "daily" ? { start: day, end: day } : getPeriodRange(kind, day, await db.getWeekStart());
      const dailyRow = kind === "daily" ? await db.getSummaryByDate(day) : undefined;
      const stored = kind === "daily" ? dailyRow?.summary : (await db.getPeriodSummary(kind, range.start))?.summary;
      const content = stored === undefined ? null : format === "text" ? markdownToPlainText(stored) : stored;

      return {
        content: [text(content ?? t("getReport.notFound", { start: range.start, end: range.end }))],
        structuredContent: {
          type: kind,
          start: range.start,
          end: range.end,
          found: content !== null,
          content,
          next_plan: dailyRow?.next_plan ?? null,
        },
      };
    })
  );

  // --- get_history: Retrieve past summaries ---
  server.registerTool(
    "get_history",
    {
      title: "Get summary history",
      description:
        "Read saved daily, weekly or monthly summaries from the past months. Use it to answer questions about what the user worked on, or for retrospectives.",
      inputSchema: {
        months: z.number().int().min(1).max(24).optional().describe("Number of months to look back (default: 6)"),
        type: z.enum(SUMMARY_TYPES).optional().describe("Which summaries to return (default: daily)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    daily(async ({ months, type }) => {
      const lookbackMonths = months ?? 6;

      if (type === "weekly" || type === "monthly") {
        const history = await db.getPeriodSummariesByMonths(type, lookbackMonths);
        const labels = { type: t(`period.${type}`), months: lookbackMonths, count: history.length };
        return {
          content: [
            text(
              history.length === 0
                ? t("history.noPeriodSummaries", labels)
                : `${t("history.periodTitle", labels)}\n${JSON.stringify(history, null, 2)}`
            ),
          ],
        };
      }

      const history = await db.getSummariesByMonths(lookbackMonths);
      if (history.length === 0) {
        return { content: [text(t("history.noSummaries", { months: lookbackMonths }))] };
      }
      return {
        content: [
          text(`${t("history.title", { count: history.length, months: lookbackMonths })}\n${JSON.stringify(history, null, 2)}`),
        ],
      };
    })
  );

  // --- search: Find logs and reports ---
  server.registerTool(
    "search",
    {
      title: "Search logs and reports",
      description:
        "Search activity logs and saved reports by keyword, best matches first. Results contain every word; if nothing does, results containing some of the words are returned and marked as partial. Matching is literal, so when a search finds nothing, try again with synonyms or related words (e.g. \"login\", \"authentication\", \"password\"). Use it to answer questions such as \"when did we decide X?\" or to find the id of a log entry.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Words to look for"),
        from: DateSchema.optional().describe("Only results on or after this date"),
        to: DateSchema.optional().describe("Only results on or before this date"),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum results per kind (default: 20)"),
      },
      outputSchema: {
        query: z.string(),
        partial: z.boolean(),
        activities: z.array(ActivityShape),
        daily: z.array(DailyShape),
        weekly: z.array(PeriodShape),
        monthly: z.array(PeriodShape),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    daily(async ({ query, from, to, limit }) => {
      const results = await db.search(query, { from, to, limit: limit ?? 20 });
      const total = results.activities.length + results.daily.length + results.weekly.length + results.monthly.length;
      return {
        content: [
          text(
            total === 0
              ? t("search.none", { query })
              : `${t(results.partial ? "search.partialTitle" : "search.title", { query, count: total })}\n${JSON.stringify(results, null, 2)}`
          ),
        ],
        structuredContent: { query, ...results },
      };
    })
  );

  // --- get_stats: Counts and time spent ---
  server.registerTool(
    "get_stats",
    {
      title: "Get activity statistics",
      description:
        "Count logs and add up the time spent in a date range, grouped by project, type, tag and day. Use it for effort reports (how many hours went into each project).",
      inputSchema: {
        from: DateSchema.optional().describe("First date (default: first day of the current month)"),
        to: DateSchema.optional().describe("Last date (default: today)"),
        project: ProjectSchema.optional().describe("Only count logs of this project"),
        tags: TagsSchema.optional().describe("Only count logs that have at least one of these tags"),
      },
      outputSchema: {
        from: z.string(),
        to: z.string(),
        count: z.number(),
        minutes: z.number(),
        byProject: z.array(GroupShape),
        byType: z.array(GroupShape),
        byTag: z.array(GroupShape),
        byDay: z.array(GroupShape),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    daily(async ({ from, to, project, tags }) => {
      const today = formatLocalDate();
      const stats = await db.getStats(from ?? `${today.slice(0, 7)}-01`, to ?? today, {
        project: normalizeProject(project) ?? undefined,
        tags: normalizeTags(tags),
      });
      const rows = (groups: { name: string; count: number; minutes: number }[], unnamed: string): string =>
        groups.length === 0
          ? t("labels.none")
          : groups
              .map((group) => t("stats.entry", { name: group.name || unnamed, count: group.count, time: formatMinutes(group.minutes) }))
              .join("\n");

      return {
        content: [
          text(
            [
              t("stats.title", { from: stats.from, to: stats.to }),
              t("stats.total", { count: stats.count, time: formatMinutes(stats.minutes) }),
              t("stats.byProjectHeader"),
              rows(stats.byProject, t("stats.noProject")),
              t("stats.byTypeHeader"),
              rows(stats.byType, ""),
              t("stats.byTagHeader"),
              rows(stats.byTag, ""),
              t("stats.byDayHeader"),
              rows(stats.byDay, ""),
            ].join("\n")
          ),
        ],
        structuredContent: { ...stats },
      };
    })
  );

  // --- list_tags: Projects and tags in use ---
  server.registerTool(
    "list_tags",
    {
      title: "List projects and tags",
      description:
        "List the project and tag names already in use, with how many logs use each. Call it before log so existing names are reused consistently.",
      outputSchema: { projects: z.array(LabelShape), tags: z.array(LabelShape) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    daily(async () => {
      const projects = await db.listProjects();
      const tags = await db.listTags();
      const render = (items: { name: string; count: number }[]): string =>
        items.length === 0 ? t("labels.none") : items.map((item) => t("labels.entry", item)).join("\n");
      return {
        content: [
          text([t("labels.title"), t("labels.projectsHeader"), render(projects), t("labels.tagsHeader"), render(tags)].join("\n")),
        ],
        structuredContent: { projects, tags },
      };
    })
  );

  // --- get_briefing: What was planned for today ---
  server.registerTool(
    "get_briefing",
    {
      title: "Get today's briefing",
      description:
        "Return what the user planned to do next in their most recent daily report. Call it when the user starts their day or asks what they were going to do. (Remem also adds this once to the first tool result of each day.)",
      outputSchema: { found: z.boolean(), date: z.string().nullable(), plan: z.string().nullable() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const today = formatLocalDate();
      // Asking explicitly counts as today's reminder, so it is not repeated automatically
      await takeDailyBriefing(db, today);
      const briefing = await getBriefing(db, today);
      return {
        content: [text(briefing ? formatBriefing(briefing, t) : t("briefing.none"))],
        structuredContent: { found: briefing !== null, date: briefing?.date ?? null, plan: briefing?.plan ?? null },
      };
    }
  );

  // --- import_git_commits: Turn commits into logs ---
  server.registerTool(
    "import_git_commits",
    {
      title: "Import Git commits",
      description:
        "Record the user's Git commits of a local repository as work logs, so nothing is missed when they forgot to log. Each commit is imported only once. By default only the commits of the repository's configured author since today.",
      inputSchema: {
        repo_path: z.string().min(1).describe("Absolute path of the local Git repository"),
        since: DateSchema.optional().describe("Import commits from this date on (default: today)"),
        project: ProjectSchema.optional().describe("Project name for the logs (default: repository folder name)"),
        all_authors: z.boolean().optional().describe("Also import commits made by other people"),
      },
      outputSchema: {
        repository: z.string(),
        project: z.string(),
        since: z.string(),
        imported: z.number(),
        skipped: z.number(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    daily(async ({ repo_path, since, project, all_authors }) => {
      try {
        const result = await importGitCommits(db, { repoPath: repo_path, since, project, allAuthors: all_authors });
        return { content: [text(t("git.imported", { ...result }))], structuredContent: { ...result } };
      } catch (error) {
        return { isError: true, content: [text(t("git.failed", { reason: error instanceof Error ? error.message : String(error) }))] };
      }
    })
  );

  // --- export: Write reports to a file ---
  server.registerTool(
    "export",
    {
      title: "Export reports",
      description:
        "Export saved reports to a Markdown, plain text or JSON file in the Remem data directory (exports folder). For PDF or a printable business document, open the dashboard and use its print view.",
      inputSchema: {
        format: z.enum(EXPORT_FORMATS).optional().describe("File format (default: markdown)"),
        type: z.enum(EXPORT_TYPES).optional().describe("Which reports to include (default: all)"),
        from: DateSchema.optional().describe("First date to include (default: no limit)"),
        to: DateSchema.optional().describe("Last date to include (default: no limit)"),
        include_logs: z.boolean().optional().describe("Also include raw activity logs that are still retained"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    daily(async ({ format, type, from, to, include_logs }) => {
      const result = await buildExport(db, { format, type, from, to, includeLogs: include_logs }, t);
      if (result.count === 0 && (result.data.activities?.length ?? 0) === 0) {
        return { content: [text(t("export.empty"))] };
      }
      const path = writeExportFile(db.dataPath, result.filename, result.content);
      return { content: [text(t("export.done", { count: result.count, path }))] };
    })
  );

  // --- open_dashboard: Start the local web UI ---
  const { openDashboard } = context;
  if (openDashboard) {
    server.registerTool(
      "open_dashboard",
      {
        title: "Open dashboard",
        description:
          "Start the local web dashboard for browsing, searching, editing, exporting and printing reports, and return its address. It only listens on this computer.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      daily(async () => ({ content: [text(t("dashboard.opened", { url: await openDashboard() }))] }))
    );
  }

  // --- configure: Update server settings ---
  server.registerTool(
    "configure",
    {
      title: "Update configuration",
      description:
        "Update server configuration (retention_days, default_template, weekly_template, monthly_template, week_start)",
      inputSchema: {
        key: z.enum(CONFIG_KEYS).describe("Configuration key to update"),
        value: z.string().min(1).describe("New value for the configuration"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    daily(async ({ key, value }) => {
      let normalizedValue = value;

      // Validate retention_days is an integer between 1 and 365
      if (key === "retention_days") {
        const trimmed = value.trim();
        const days = Number(trimmed);
        if (!/^\d+$/.test(trimmed) || days < 1 || days > 365) {
          return { isError: true, content: [text(t("config.invalidRetention"))] };
        }
        normalizedValue = String(days);
      }

      if (key === "week_start") {
        normalizedValue = value.trim().toLowerCase();
        if (!(WEEK_STARTS as readonly string[]).includes(normalizedValue)) {
          return { isError: true, content: [text(t("config.invalidWeekStart"))] };
        }
      }

      await db.setConfig(key, normalizedValue);
      return { content: [text(t("config.updated", { key, value: normalizedValue }))] };
    })
  );

  // --- get_config: Read current configuration ---
  server.registerTool(
    "get_config",
    {
      title: "Get configuration",
      description: "Get current server configuration",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    daily(async () => {
      const block = (value: string): string => `\n\`\`\`\n${value}\n\`\`\``;
      return {
        content: [
          text(
            [
              t("config.current"),
              `- ${t("config.retentionDays")}: ${await db.getRetentionDays()}`,
              `- ${t("config.weekStart")}: ${await db.getWeekStart()}`,
              `- ${t("config.defaultTemplate")}:${block(await db.getDefaultTemplate())}`,
              `- ${t("config.weeklyTemplate")}:${block(await db.getPeriodTemplate("weekly"))}`,
              `- ${t("config.monthlyTemplate")}:${block(await db.getPeriodTemplate("monthly"))}`,
            ].join("\n")
          ),
        ],
      };
    })
  );
}
