/**
 * Builds the MCP server: usage instructions, tools and prompts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TFunction } from "i18next";

import type { RememDatabase } from "./database.js";
import { registerPrompts } from "./prompts.js";
import { registerTools, type ToolContext } from "./tools.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

/**
 * Guidance sent to the client when it connects. MCP clients (Claude, Codex,
 * Muse Code and others) pass it to the model, so it explains when and how to
 * use the tools without the user having to describe the workflow.
 */
export const SERVER_INSTRUCTIONS = `Remem is the user's local work journal. Use it to record what was done and to write daily, weekly and monthly reports.

Recording:
- Call \`log\` when a meaningful unit of work is finished, a decision is made, something is approved, or the user asks to remember something. Do it without being asked, one entry per item, in the user's language.
- Types: work (something done), decision (a choice and its reason), memo (a note), approval (something approved).
- Write each entry so it is understandable later on its own: say what was done and why, and name the pull request, ticket or file when there is one.
- Set \`project\` to the repository or project name and add a few \`tags\`. Call \`list_tags\` first and reuse existing names instead of inventing variants.
- Add \`minutes\` when the time spent is known. Use \`date\` to record something that happened on an earlier day.
- To fix a mistake use \`update_log\` or \`delete_log\` (find the id with \`search\`). \`import_git_commits\` records commits that were not logged.

Start of the day: the first Remem tool result of each day ends with what the user planned in their previous report. Tell the user about it right away. \`get_briefing\` returns it on request.

Daily report: call \`prepare_report\`, write the report by following the returned template and target language, show it to the user, then store it with \`save_summary\`. Pass what the user plans to do next as \`next_plan\`; it becomes the next day's reminder.
Weekly or monthly report: call \`prepare_period_report\`, write the report the same way, then store it with \`save_period_summary\`.
Looking back: \`search\` finds logs and reports by keyword, \`get_history\` returns past summaries, \`get_stats\` adds up time per project, \`get_report\` returns one report (format "text" for pasting into chat or e-mail).

Notes:
- Dates are YYYY-MM-DD in the user's local timezone. Omit the date to use today; do not guess it.
- Raw logs are deleted after the retention period, saved summaries are kept forever. Save a summary for any day that should be kept.
- \`export\` writes Markdown, plain text or JSON files. For PDF or a printable business document, or to let the user read and edit reports, call \`open_dashboard\` and give them the address.
- Never record passwords, API keys or other secrets. Values that look like credentials are masked automatically; if that happens, tell the user.`;

/** Create a fully configured MCP server */
export function createServer(db: RememDatabase, t: TFunction, context: ToolContext = {}): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      title: "Remem",
      version: PACKAGE_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerTools(server, db, t, context);
  registerPrompts(server, t);

  return server;
}
