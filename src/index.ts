#!/usr/bin/env node
/**
 * Remem - MCP Server for Daily Activity Logging & Reporting
 *
 * A local MCP server that captures daily activities, generates reports,
 * and preserves summaries for long-term reflection.
 *
 * Usage:
 *   remem                 Start the MCP server on stdio (default)
 *   remem ui [--port N]   Start the web dashboard
 *   remem log ...         Record an activity from a script or hook
 *   remem import-commits  Record Git commits as activities
 *   remem backup|restore  Save or load a full backup
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "node:util";

import { createBackup, readBackupFile, restoreBackup } from "./backup.js";
import { RememDatabase } from "./database.js";
import { writeExportFile } from "./export.js";
import { importGitCommits } from "./git.js";
import { detectLanguage, initI18n } from "./i18n.js";
import { takeDailyBriefing, getBriefing } from "./plan.js";
import { ACTIVITY_TYPES } from "./schema.js";
import { runSetup, SETUP_CLIENTS, type SetupClient } from "./setup.js";
import { createServer } from "./server.js";
import { formatLocalDate, formatLocalTimestamp, isValidCalendarDate } from "./utils.js";
import { PACKAGE_VERSION } from "./version.js";
import { DEFAULT_PORT, startWebServer, type WebServerHandle } from "./web/server.js";

const HELP = `Remem ${PACKAGE_VERSION}

Usage:
  remem                              Start the MCP server on stdio (default)
  remem setup [options]              Register Remem with Claude Code, Claude Desktop and Codex
      --hooks  --dry-run  --client ${SETUP_CLIENTS.join("|")}
  remem ui [--port N]                Start the web dashboard (default port: ${DEFAULT_PORT})
  remem log <type> <text> [options]  Record an activity (type: ${ACTIVITY_TYPES.join(", ")})
      --project NAME  --tags a,b  --minutes N  --date YYYY-MM-DD
  remem import-commits [options]     Record Git commits as work logs (each commit once)
      --repo PATH (default: .)  --since YYYY-MM-DD (default: today)
      --project NAME  --all-authors  --quiet
  remem briefing [--always]          Print what was planned for today (once per day)
  remem backup [FILE]                Write a full backup as JSON
  remem restore FILE [--overwrite]   Merge a backup into the database
  remem --version                    Show the version
  remem --help                       Show this help

Environment:
  REMEM_DATA_DIR        Data directory (default: ~/.remem)
  REMEM_LANG            Language: en or ja (default: system language)
  REMEM_UI_PORT         Dashboard port (default: ${DEFAULT_PORT})
`;

/** Read a port from text; undefined when missing, an error when invalid */
function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

/** Run `fn` once when the process is asked to stop */
function onShutdown(fn: () => Promise<void>): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void fn().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // An MCP client closing stdin means the session is over
  process.stdin.on("close", stop);
}

/** Start the MCP server on stdio */
async function runMcpServer(): Promise<void> {
  const language = detectLanguage();
  const t = await initI18n(language);

  const db = new RememDatabase();
  await db.initialize();

  // The dashboard is started on demand and shared by later calls
  let dashboard: Promise<WebServerHandle> | undefined;
  const openDashboard = async (): Promise<string> => {
    dashboard ??= startWebServer(db, {
      port: parsePort(process.env.REMEM_UI_PORT),
      fallbackToFreePort: true,
      language,
    }).catch((error: unknown) => {
      dashboard = undefined;
      throw error;
    });
    return (await dashboard).url;
  };

  const server = createServer(db, t, { openDashboard });

  onShutdown(async () => {
    if (dashboard) await (await dashboard).close().catch(() => undefined);
    await db.close();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Start only the web dashboard */
async function runDashboard(args: string[]): Promise<void> {
  const portIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const inlinePort = args.find((arg) => arg.startsWith("--port="))?.slice("--port=".length);
  const port = parsePort(inlinePort ?? (portIndex >= 0 ? args[portIndex + 1] : undefined) ?? process.env.REMEM_UI_PORT);

  const language = detectLanguage();
  const t = await initI18n(language);

  const db = new RememDatabase();
  await db.initialize();

  const handle = await startWebServer(db, { port, language });
  console.log(t("dashboard.cliStarted", { url: handle.url }));
  console.log(t("dashboard.cliStop"));

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void handle
      .close()
      .then(() => db.close())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** Open the database, run one command and close it again */
async function withDatabase(run: (db: RememDatabase, t: Awaited<ReturnType<typeof initI18n>>) => Promise<void>): Promise<void> {
  const t = await initI18n(detectLanguage());
  const db = new RememDatabase();
  await db.initialize();
  try {
    await run(db, t);
  } finally {
    await db.close();
  }
}

/** `remem log <type> <text>`: record an activity without an MCP client (scripts, hooks) */
async function runLog(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      tags: { type: "string" },
      minutes: { type: "string" },
      date: { type: "string" },
    },
  });
  const [type, ...words] = positionals;
  const content = words.join(" ").trim();
  if (!(ACTIVITY_TYPES as readonly string[]).includes(type ?? "") || content === "") {
    throw new Error(`Usage: remem log <${ACTIVITY_TYPES.join("|")}> <text>`);
  }

  const minutes = values.minutes === undefined ? undefined : Number(values.minutes);
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
    throw new Error("--minutes must be a whole number between 1 and 1440");
  }
  if (values.date !== undefined && !isValidCalendarDate(values.date)) {
    throw new Error("--date must be a valid date in YYYY-MM-DD format");
  }
  const now = formatLocalTimestamp();
  const timestamp = values.date && values.date !== now.slice(0, 10) ? `${values.date} 12:00:00` : now;

  await withDatabase(async (db, t) => {
    const result = await db.insertActivity(type, content, {
      project: values.project,
      tags: values.tags?.split(","),
      minutes,
      timestamp,
    });
    console.log(t("log.success", { type }));
    if (result.redacted > 0) console.log(t("redact.notice", { count: result.redacted }));
  });
}

/** `remem import-commits`: record Git commits as work logs */
async function runImportCommits(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      since: { type: "string" },
      project: { type: "string" },
      "all-authors": { type: "boolean" },
      quiet: { type: "boolean" },
    },
  });
  try {
    await withDatabase(async (db, t) => {
      const result = await importGitCommits(db, {
        repoPath: values.repo,
        since: values.since,
        project: values.project,
        allAuthors: values["all-authors"],
      });
      if (!values.quiet) console.log(t("git.imported", { ...result }));
    });
  } catch (error) {
    // In a hook, a folder that is not a Git repository is normal and must not look like a failure
    if (!values.quiet) throw error;
  }
}

/** `remem briefing`: print the plan from the previous report (used by a session start hook) */
async function runBriefing(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { always: { type: "boolean" } } });
  await withDatabase(async (db, t) => {
    const today = formatLocalDate();
    const briefing = values.always ? await getBriefing(db, today) : await takeDailyBriefing(db, today);
    if (briefing) console.log(t("briefing.cli", { ...briefing }));
  });
}

/** `remem setup`: register Remem with the MCP clients on this computer */
async function runSetupCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { hooks: { type: "boolean" }, "dry-run": { type: "boolean" }, client: { type: "string", multiple: true } },
  });
  const clients = values.client as string[] | undefined;
  const unknown = clients?.find((client) => !(SETUP_CLIENTS as readonly string[]).includes(client));
  if (unknown) throw new Error(`Unknown client: ${unknown} (use ${SETUP_CLIENTS.join(", ")})`);

  const t = await initI18n(detectLanguage());
  const results = await runSetup({ clients: clients as SetupClient[] | undefined, hooks: values.hooks, dryRun: values["dry-run"] });

  console.log(t("setup.title"));
  for (const result of results) {
    const key = result.status === "added" && result.detail ? "setup.addedFile" : `setup.${result.status}`;
    console.log(`  ${t(key, { name: t(`setup.${result.target}`), detail: result.detail ?? "" })}`);
  }
  if (values["dry-run"]) console.log(t("setup.dryRun"));
  if (results.every((result) => result.status === "not_found")) console.log(t("setup.nothing"));
  else if (results.some((result) => result.status === "added")) console.log(t("setup.restart"));
  if (!values.hooks && results.some((result) => result.target === "claude-code" && result.status !== "not_found")) {
    console.log(t("setup.hooksHint"));
  }
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

/** `remem backup [FILE]`: write everything to a JSON file */
async function runBackup(args: string[]): Promise<void> {
  const { writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  await withDatabase(async (db, t) => {
    const content = `${JSON.stringify(await createBackup(db), null, 2)}\n`;
    let path: string;
    if (args[0]) {
      path = resolve(args[0]);
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    } else {
      const stamp = formatLocalTimestamp().replace(/[-:]/g, "").replace(" ", "-");
      path = writeExportFile(db.dataPath, `remem-backup-${stamp}.json`, content);
    }
    console.log(t("backup.done", { path }));
  });
}

/** `remem restore FILE`: merge a backup into the database */
async function runRestore(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { overwrite: { type: "boolean" } } });
  if (!positionals[0]) throw new Error("Usage: remem restore FILE [--overwrite]");
  const backup = readBackupFile(positionals[0]);
  await withDatabase(async (db, t) => {
    console.log(t("backup.restored", { ...(await restoreBackup(db, backup, { overwrite: values.overwrite })) }));
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
  } else if (command === "--version" || command === "-v") {
    console.log(PACKAGE_VERSION);
  } else if (command === "ui" || command === "dashboard") {
    await runDashboard(rest);
  } else if (command === "setup") {
    await runSetupCommand(rest);
  } else if (command === "briefing") {
    await runBriefing(rest);
  } else if (command === "log") {
    await runLog(rest);
  } else if (command === "import-commits") {
    await runImportCommits(rest);
  } else if (command === "backup") {
    await runBackup(rest);
  } else if (command === "restore") {
    await runRestore(rest);
  } else if (command === undefined) {
    await runMcpServer();
  } else {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(2);
  }
}

main().catch((error) => {
  console.error("Remem:", error instanceof Error ? error.message : error);
  process.exit(1);
});
