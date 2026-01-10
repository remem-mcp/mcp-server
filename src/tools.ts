/**
 * MCP Tool definitions for Remem
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TFunction } from "i18next";
import { z } from "zod";

import type { RememDatabase } from "./database.js";
import type { ConfigKey } from "./schema.js";

/** Activity type enum for validation */
const ActivityTypeSchema = z.enum(["work", "decision", "memo", "approval"]);

/** Date string in YYYY-MM-DD format */
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .describe("Date in YYYY-MM-DD format");

/** Get today's date in YYYY-MM-DD */
function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Register all MCP tools
 */
export function registerTools(server: McpServer, db: RememDatabase, t: TFunction): void {
  // --- log: Record an activity ---
  server.registerTool(
    "log",
    {
      description: "Record an activity (work, decision, memo, or approval) to the database",
      inputSchema: {
        type: ActivityTypeSchema.describe("Type of activity"),
        content: z.string().min(1).describe("Content to remember"),
      },
    },
    async ({ type, content }) => {
      await db.insertActivity(type, content);
      return {
        content: [{ type: "text", text: t("log.success", { type }) }],
      };
    }
  );

  // --- prepare_report: Gather data for report generation ---
  server.registerTool(
    "prepare_report",
    {
      description: "Gather logs and template for AI to generate a daily report",
      inputSchema: {
        date: DateSchema.optional().describe("Target date (defaults to today)"),
        custom_instruction: z.string().optional().describe("Additional instructions for the AI"),
      },
    },
    async ({ date, custom_instruction }) => {
      const targetDate = date ?? getToday();
      const logs = await db.getActivitiesByDate(targetDate);
      const template = await db.getDefaultTemplate();
      const existingSummary = await db.getSummaryByDate(targetDate);

      // Cleanup old activities
      const retentionDays = await db.getRetentionDays();
      const deletedCount = await db.cleanupOldActivities(retentionDays);

      if (logs.length === 0) {
        return {
          content: [
            { type: "text", text: t("report.noLogs") },
            { type: "text", text: t("report.date", { date: targetDate }) },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: t("report.title", { date: targetDate }) },
          { type: "text", text: `${t("report.logsHeader", { count: logs.length })}\n${JSON.stringify(logs, null, 2)}` },
          { type: "text", text: `${t("report.templateHeader")}\n${template}` },
          { type: "text", text: t("report.languageHeader", { language: t("language.name") }) },
          ...(existingSummary
            ? [{ type: "text" as const, text: `${t("report.existingSummaryHeader")}\n${existingSummary.summary}` }]
            : []),
          ...(custom_instruction
            ? [{ type: "text" as const, text: `${t("report.instructionsHeader")}\n${custom_instruction}` }]
            : []),
          ...(deletedCount > 0
            ? [{ type: "text" as const, text: t("report.cleanedUp", { count: deletedCount }) }]
            : []),
        ],
      };
    }
  );

  // --- save_summary: Persist the generated summary ---
  server.registerTool(
    "save_summary",
    {
      description: "Save the generated report summary to long-term storage",
      inputSchema: {
        date: DateSchema.describe("Date of the summary"),
        summary: z.string().min(1).describe("Summarized report content"),
      },
    },
    async ({ date, summary }) => {
      await db.upsertSummary(date, summary);
      return {
        content: [{ type: "text", text: t("summary.saved") }],
      };
    }
  );

  // --- get_history: Retrieve past summaries ---
  server.registerTool(
    "get_history",
    {
      description: "Retrieve past summaries for long-term reflection",
      inputSchema: {
        months: z.number().int().min(1).max(24).optional().describe("Number of months to look back (default: 6)"),
      },
    },
    async ({ months }) => {
      const lookbackMonths = months ?? 6;
      const history = await db.getSummariesByMonths(lookbackMonths);

      if (history.length === 0) {
        return {
          content: [{ type: "text", text: t("history.noSummaries", { months: lookbackMonths }) }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `${t("history.title", { count: history.length, months: lookbackMonths })}\n${JSON.stringify(history, null, 2)}`,
          },
        ],
      };
    }
  );

  // --- configure: Update server settings ---
  server.registerTool(
    "configure",
    {
      description: "Update server configuration (retention_days, default_template)",
      inputSchema: {
        key: z.enum(["retention_days", "default_template"]).describe("Configuration key to update"),
        value: z.string().min(1).describe("New value for the configuration"),
      },
    },
    async ({ key, value }) => {
      // Validate retention_days is a positive integer
      if (key === "retention_days") {
        const days = Number.parseInt(value, 10);
        if (Number.isNaN(days) || days < 1 || days > 365) {
          return {
            content: [{ type: "text", text: t("config.invalidRetention") }],
          };
        }
      }

      await db.setConfig(key as ConfigKey, value);
      return {
        content: [{ type: "text", text: t("config.updated", { key, value }) }],
      };
    }
  );

  // --- get_config: Read current configuration ---
  server.registerTool(
    "get_config",
    {
      description: "Get current server configuration",
    },
    async () => {
      const retentionDays = await db.getRetentionDays();
      const template = await db.getDefaultTemplate();

      return {
        content: [
          {
            type: "text",
            text: `${t("config.current")}\n- ${t("config.retentionDays")}: ${retentionDays}\n- ${t("config.defaultTemplate")}:\n\`\`\`\n${template}\n\`\`\``,
          },
        ],
      };
    }
  );
}
