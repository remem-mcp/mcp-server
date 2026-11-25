/**
 * MCP prompts: ready-made requests that clients show as commands
 * (for example slash commands), so common workflows take one step.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TFunction } from "i18next";
import { z } from "zod";

import { isValidCalendarDate } from "./utils.js";

const DateArgument = z
  .string()
  .optional()
  .describe("Date in YYYY-MM-DD format (defaults to today)");

/** Build a single user message */
function userMessage(text: string): { messages: { role: "user"; content: { type: "text"; text: string } }[] } {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** Use the date only when it is valid, so a typo falls back to "today" wording */
function dateSuffix(t: TFunction, date: string | undefined): string {
  const value = date?.trim() ?? "";
  return isValidCalendarDate(value) ? t("prompts.forDate", { date: value }) : "";
}

/**
 * Register all MCP prompts
 */
export function registerPrompts(server: McpServer, t: TFunction): void {
  server.registerPrompt(
    "daily_report",
    {
      title: t("prompts.dailyTitle"),
      description: t("prompts.dailyDescription"),
      argsSchema: { date: DateArgument },
    },
    ({ date }) => userMessage(t("prompts.daily", { date: dateSuffix(t, date) }))
  );

  server.registerPrompt(
    "weekly_report",
    {
      title: t("prompts.weeklyTitle"),
      description: t("prompts.weeklyDescription"),
      argsSchema: { date: DateArgument },
    },
    ({ date }) => userMessage(t("prompts.weekly", { date: dateSuffix(t, date) }))
  );

  server.registerPrompt(
    "monthly_report",
    {
      title: t("prompts.monthlyTitle"),
      description: t("prompts.monthlyDescription"),
      argsSchema: { date: DateArgument },
    },
    ({ date }) => userMessage(t("prompts.monthly", { date: dateSuffix(t, date) }))
  );

  server.registerPrompt(
    "start_day",
    {
      title: t("prompts.startDayTitle"),
      description: t("prompts.startDayDescription"),
    },
    () => userMessage(t("prompts.startDay"))
  );

  server.registerPrompt(
    "log_session",
    {
      title: t("prompts.logSessionTitle"),
      description: t("prompts.logSessionDescription"),
    },
    () => userMessage(t("prompts.logSession"))
  );
}
