import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RememDatabase } from "../src/database.js";
import { initI18n } from "../src/i18n.js";
import { createServer } from "../src/server.js";
import { addDays, formatLocalDate, getPeriodRange } from "../src/utils.js";
import { createTestDatabase, insertAt } from "./helpers.js";

describe("MCP tools", () => {
  let db: RememDatabase;
  let cleanup: () => Promise<void>;
  let client: Client;
  let server: McpServer;

  /** Call a tool and return its text output and error flag */
  const call = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<{ text: string; isError: boolean; data: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return {
      text: content.map((item) => item.text).join("\n"),
      isError: result.isError === true,
      data: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
  };

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDatabase());
    server = createServer(db, await initI18n("en"), { openDashboard: () => Promise.resolve("http://localhost:3939/") });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await cleanup();
  });

  it("tells the client how to use the server", () => {
    const instructions = client.getInstructions() ?? "";
    for (const tool of ["log", "list_tags", "prepare_report", "save_summary", "prepare_period_report", "get_history"]) {
      expect(instructions).toContain(`\`${tool}\``);
    }
    expect(client.getServerVersion()?.title).toBe("Remem");
  });

  it("offers prompts for the common workflows", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      "daily_report",
      "log_session",
      "monthly_report",
      "start_day",
      "weekly_report",
    ]);

    const text = async (name: string, args?: Record<string, string>): Promise<string> => {
      const result = await client.getPrompt({ name, arguments: args });
      return (result.messages[0].content as { text: string }).text;
    };

    expect(await text("daily_report")).toContain("Write my daily report with Remem. Call prepare_report");
    expect(await text("daily_report", { date: "2026-01-21" })).toContain("daily report for 2026-01-21 with Remem");
    // An invalid date is ignored instead of being passed on to the model
    expect(await text("daily_report", { date: "tomorrow" })).toContain("daily report with Remem");
    expect(await text("weekly_report")).toContain('period "weekly"');
    expect(await text("monthly_report")).toContain("save_period_summary");
    expect(await text("log_session")).toContain("list_tags");
  });

  it("points to the next step after preparing a report", async () => {
    await call("log", { type: "work", content: "x" });
    expect((await call("prepare_report", { date: formatLocalDate() })).text).toContain(`call save_summary with date ${formatLocalDate()}`);

    await db.upsertSummary("2026-01-19", "Monday");
    expect((await call("prepare_period_report", { period: "weekly", date: "2026-01-21" })).text).toContain(
      'call save_period_summary with period "weekly" and date 2026-01-19'
    );
  });

  it("registers every tool with a title", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "configure",
      "delete_log",
      "export",
      "get_briefing",
      "get_config",
      "get_history",
      "get_report",
      "get_stats",
      "import_git_commits",
      "list_tags",
      "log",
      "open_dashboard",
      "prepare_period_report",
      "prepare_report",
      "save_period_summary",
      "save_summary",
      "search",
      "update_log",
    ]);
    expect(tools.every((tool) => typeof tool.title === "string" && tool.title.length > 0)).toBe(true);
  });

  it("logs activities with project and tags and reports them", async () => {
    expect((await call("log", { type: "work", content: "Reviewed PR", project: "Remem", tags: ["#review"] })).text).toContain(
      "Logged (work)"
    );
    await call("log", { type: "memo", content: "Unrelated note" });

    const all = await call("prepare_report");
    expect(all.text).toContain("Logs (2 entries)");
    expect(all.text).toContain('"project": "Remem"');
    expect(all.text).toContain('"review"');

    const filtered = await call("prepare_report", { project: "Remem" });
    expect(filtered.text).toContain("Logs (1 entries)");
    expect(filtered.text).toContain("Project: Remem");
    expect(filtered.text).not.toContain("Unrelated note");

    const byTag = await call("prepare_report", { tags: ["review"] });
    expect(byTag.text).toContain("Tags: review");
    expect(byTag.text).not.toContain("Unrelated note");

    const labels = await call("list_tags");
    expect(labels.text).toContain("- Remem (1)");
    expect(labels.text).toContain("- review (1)");
  });

  it("rejects invalid input", async () => {
    expect((await call("log", { type: "party", content: "x" })).isError).toBe(true);
    expect((await call("prepare_report", { date: "2026-13-45" })).isError).toBe(true);
    expect((await call("log", { type: "work", content: "x", project: "p".repeat(51) })).isError).toBe(true);
    expect((await call("save_period_summary", { period: "yearly", date: "2026-01-21", summary: "x" })).isError).toBe(true);
  });

  it("prepares and saves weekly and monthly reports", async () => {
    // Week of Monday 2026-01-19 to Sunday 2026-01-25
    await db.upsertSummary("2026-01-19", "Monday summary");
    await db.upsertSummary("2026-01-26", "Next week summary");
    await insertAt(db, "2026-01-19 10:00:00", "already summarized");
    await insertAt(db, "2026-01-21 10:00:00", "not summarized yet");

    const weekly = await call("prepare_period_report", { period: "weekly", date: "2026-01-21" });
    expect(weekly.text).toContain("Weekly Report Data (2026-01-19 to 2026-01-25)");
    expect(weekly.text).toContain("Daily Summaries (1 days)");
    expect(weekly.text).toContain("Monday summary");
    expect(weekly.text).not.toContain("Next week summary");
    expect(weekly.text).toContain("not summarized yet");
    expect(weekly.text).not.toContain("already summarized");
    expect(weekly.text).toContain("Weekly Report");

    const saved = await call("save_period_summary", { period: "weekly", date: "2026-01-21", summary: "The week" });
    expect(saved.text).toContain("2026-01-19 to 2026-01-25");
    expect((await db.getPeriodSummary("weekly", "2026-01-19"))?.summary).toBe("The week");
    expect((await call("prepare_period_report", { period: "weekly", date: "2026-01-25" })).text).toContain("Existing Summary\nThe week");

    const monthly = await call("prepare_period_report", { period: "monthly", date: "2026-01-21" });
    expect(monthly.text).toContain("Monthly Report Data (2026-01-01 to 2026-01-31)");
    expect(monthly.text).toContain("Daily Summaries (2 days)");

    const empty = await call("prepare_period_report", { period: "monthly", date: "2020-05-05" });
    expect(empty.text).toContain("No daily summaries or logs found for 2020-05-01 to 2020-05-31");
  });

  it("uses the configured week start", async () => {
    expect((await call("configure", { key: "week_start", value: "Sunday" })).text).toContain("week_start = sunday");
    const saved = await call("save_period_summary", { period: "weekly", date: "2026-01-21", summary: "x" });
    expect(saved.text).toContain("2026-01-18 to 2026-01-24");

    expect((await call("configure", { key: "week_start", value: "friday" })).isError).toBe(true);
  });

  it("returns history by type", async () => {
    const today = formatLocalDate();
    await call("save_summary", { date: today, summary: "Today" });
    await call("save_period_summary", { period: "monthly", date: today, summary: "This month" });

    expect((await call("get_history")).text).toContain("Summary History (1 days over 6 months)");
    expect((await call("get_history", { type: "monthly", months: 1 })).text).toContain("This month");
    expect((await call("get_history", { type: "weekly" })).text).toContain("No Weekly summaries found");
    expect(getPeriodRange("monthly", today).start).toBe(`${today.slice(0, 7)}-01`);
  });

  it("validates retention_days strictly", async () => {
    for (const value of ["30abc", "1.5", "0", "366", "-5"]) {
      expect((await call("configure", { key: "retention_days", value })).isError).toBe(true);
    }
    expect((await call("configure", { key: "retention_days", value: " 060 " })).text).toContain("retention_days = 60");
    expect(await db.getRetentionDays()).toBe(60);

    const config = await call("get_config");
    expect(config.text).toContain("retention_days: 60");
    expect(config.text).toContain("Weekly Report");
  });

  it("exports reports to a file", async () => {
    expect((await call("export")).text).toContain("Nothing to export");

    await db.upsertSummary("2026-01-20", "Exported body");
    const result = await call("export", { format: "markdown" });
    const path = /to (.+\.md)$/.exec(result.text)?.[1] ?? "";

    expect(result.text).toContain("Exported 1 report(s)");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("Exported body");
  });

  it("records time, back-dated entries and structured results", async () => {
    const logged = await call("log", { type: "work", content: "Timed work", project: "Remem", minutes: 90 });
    expect(logged.data).toMatchObject({ redacted: 0 });
    expect(typeof logged.data.id).toBe("number");

    const past = await call("log", { type: "memo", content: "Forgot to log", date: "2026-01-20", time: "14:30" });
    expect(past.data.ts).toBe("2026-01-20 14:30:00");
    expect((await call("log", { type: "memo", content: "No time given", date: "2026-01-20" })).data.ts).toBe("2026-01-20 12:00:00");
    expect((await call("log", { type: "memo", content: "x", time: "25:00" })).isError).toBe(true);
    expect((await call("log", { type: "memo", content: "x", minutes: 0 })).isError).toBe(true);

    const report = await call("prepare_report");
    expect(report.text).toContain("Total: 1h 30m");
    expect(report.data).toMatchObject({ total_minutes: 90, existing_summary: null, previous_plan: null });
    expect((report.data.logs as unknown[]).length).toBe(1);

    const stats = await call("get_stats", { from: "2026-01-01", to: formatLocalDate() });
    expect(stats.text).toContain("- Remem: 1 log(s), 1h 30m");
    // The back-dated January entries were older than retention_days, so prepare_report removed them
    expect(stats.data).toMatchObject({ count: 1, minutes: 90 });
  });

  it("corrects and deletes log entries", async () => {
    const id = (await call("log", { type: "work", content: "Tpyo", project: "Remem", tags: ["a"] })).data.id as number;

    const updated = await call("update_log", { id, content: "Typo fixed", minutes: 20 });
    expect(updated.text).toContain(`Log entry ${id} updated`);
    expect(updated.data.activity).toMatchObject({ content: "Typo fixed", project: "Remem", tags: ["a"], minutes: 20 });

    expect((await call("update_log", { id, project: "", tags: [], minutes: 0 })).data.activity).toMatchObject({
      project: null,
      tags: [],
      minutes: null,
    });
    expect((await call("update_log", { id: 9999, content: "x" })).isError).toBe(true);

    expect((await call("delete_log", { id })).text).toContain("deleted");
    expect((await call("delete_log", { id })).isError).toBe(true);
  });

  it("masks secrets and says so", async () => {
    const logged = await call("log", { type: "memo", content: "db password: sup3rs3cret for staging" });
    expect(logged.text).toContain("masked as [REDACTED]");
    expect(logged.data.redacted).toBe(1);
    expect((await call("search", { query: "sup3rs3cret" })).text).toContain("Nothing found");
    expect((await call("save_summary", { date: "2026-01-20", summary: "token=abcdef123456" })).text).toContain("[REDACTED]");
    expect((await db.getSummaryByDate("2026-01-20"))?.summary).toBe("token=[REDACTED]");
  });

  it("searches logs and reports", async () => {
    await call("log", { type: "decision", content: "Adopt Kysely for queries", project: "Remem" });
    await call("save_summary", { date: "2026-01-20", summary: "Evaluated Kysely and Drizzle" });

    const found = await call("search", { query: "kysely" });
    expect(found.text).toContain('Search Results for "kysely" (2 found)');
    expect((found.data.activities as unknown[]).length).toBe(1);
    expect((found.data.daily as unknown[]).length).toBe(1);
    expect((await call("search", { query: "kysely drizzle" })).data).toMatchObject({ activities: [] });
    expect((await call("search", { query: "   " })).isError).toBe(true);
  });

  it("returns one report as Markdown or plain text", async () => {
    await call("save_summary", { date: "2026-01-20", summary: "## Report\n- **done** item", next_plan: "- next thing" });
    await call("save_period_summary", { period: "weekly", date: "2026-01-21", summary: "## Week\n- shipped" });

    expect((await call("get_report", { date: "2026-01-20" })).text).toBe("## Report\n- **done** item");
    const plain = await call("get_report", { date: "2026-01-20", format: "text" });
    expect(plain.text).toBe("■ Report\n・done item");
    expect(plain.data).toMatchObject({ found: true, next_plan: "- next thing", start: "2026-01-20" });

    expect((await call("get_report", { type: "weekly", date: "2026-01-25" })).data).toMatchObject({
      found: true,
      start: "2026-01-19",
      end: "2026-01-25",
    });
    const missing = await call("get_report", { type: "monthly", date: "2020-05-05" });
    expect(missing.text).toContain("No report has been saved for 2020-05-01 to 2020-05-31");
    expect(missing.data.found).toBe(false);
  });

  it("shows yesterday's plan once, on the first call of the day", async () => {
    const yesterday = addDays(formatLocalDate(), -1);
    await db.upsertSummary(yesterday, "## Report\n- did things", "- finish the search feature\n- measure performance");

    const first = await call("list_tags");
    expect(first.text).toContain(`Planned for Today (from the report of ${yesterday})`);
    expect(first.text).toContain("- finish the search feature");
    expect(first.text).toContain("## Projects and Tags");

    // Not repeated on later calls the same day
    expect((await call("list_tags")).text).not.toContain("Planned for Today");
    expect((await call("log", { type: "memo", content: "x" })).text).not.toContain("Planned for Today");

    // Still available on request, and part of the report data
    const briefing = await call("get_briefing");
    expect(briefing.data).toMatchObject({ found: true, date: yesterday });
    const report = await call("prepare_report");
    expect(report.text).toContain(`Planned in the Previous Report (${yesterday})`);
    expect(report.data.previous_plan).toMatchObject({ date: yesterday });
  });

  it("does not attach the plan to failed calls, and reports when there is none", async () => {
    expect((await call("get_briefing")).data).toMatchObject({ found: false, plan: null });

    await db.upsertSummary(addDays(formatLocalDate(), -1), "report", "- plan");
    // get_briefing above already counted as today's reminder; reset it
    await db.setState("last_briefing_date", "");
    const failed = await call("update_log", { id: 9999, content: "x" });
    expect(failed.isError).toBe(true);
    expect(failed.text).not.toContain("Planned for Today");
    expect((await call("get_config")).text).toContain("Planned for Today");
  });

  it("imports git commits and reports failures", async () => {
    const failed = await call("import_git_commits", { repo_path: "/definitely/not/here" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("Could not import commits");
  });

  it("opens the dashboard", async () => {
    expect((await call("open_dashboard")).text).toContain("http://localhost:3939/");
  });
});
