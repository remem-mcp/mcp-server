/**
 * Local web dashboard for browsing and editing reports.
 *
 * The server only listens on the loopback interface and rejects requests whose
 * Host / Origin headers are not local, so other machines and other websites
 * (DNS rebinding, cross-site requests) cannot read or change the data.
 */

import type { TFunction } from "i18next";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { RememDatabase } from "../database.js";
import { buildExport, EXPORT_FORMATS, EXPORT_TYPES, type ExportFormat, type ExportType } from "../export.js";
import { getUiMessages, initI18n, type SupportedLanguage } from "../i18n.js";
import { getBriefing } from "../plan.js";
import { markdownToPlainText } from "../plaintext.js";
import { ACTIVITY_TYPES, SUMMARY_TYPES, type SummaryType } from "../schema.js";
import { formatLocalDate, getPeriodRange, isValidCalendarDate, MAX_LABEL_LENGTH, normalizeTags } from "../utils.js";
import { PACKAGE_VERSION } from "../version.js";

/** Default port of the dashboard */
export const DEFAULT_PORT = 3939;

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SUMMARY_LENGTH = 200_000;

/** Static files that may be served, with their content types */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

export interface WebServerOptions {
  /** Port to listen on (default 3939; 0 picks a free port) */
  port?: number;
  /** If the port is taken, fall back to any free port instead of failing */
  fallbackToFreePort?: boolean;
  /** Language used when the browser does not ask for a supported one */
  language: SupportedLanguage;
}

export interface WebServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** An error that is reported to the client with a specific status code */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Read an optional YYYY-MM-DD query parameter, rejecting invalid dates */
function dateParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  if (value === null || value === "") return undefined;
  if (!isValidCalendarDate(value)) throw new HttpError(400, `Invalid date: ${name}`);
  return value;
}

function requiredDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !isValidCalendarDate(value)) throw new HttpError(400, `Invalid date: ${name}`);
  return value;
}

function summaryType(value: unknown): SummaryType {
  if (typeof value === "string" && (SUMMARY_TYPES as readonly string[]).includes(value)) return value as SummaryType;
  throw new HttpError(400, "Invalid type");
}

/** Read and parse a JSON request body with a size limit */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "Invalid JSON body");
}

/** Start the dashboard server */
export async function startWebServer(db: RememDatabase, options: WebServerOptions): Promise<WebServerHandle> {
  const translators: Record<SupportedLanguage, TFunction> = { en: await initI18n("en"), ja: await initI18n("ja") };
  let port = 0;

  /**
   * Language for one request: the `lang` query parameter chosen in the
   * dashboard, then the browser's Accept-Language, then the server default.
   */
  const resolveLanguage = (req: IncomingMessage, url: URL): SupportedLanguage => {
    const requested = url.searchParams.get("lang");
    if (requested === "ja" || requested === "en") return requested;
    const preferred = (req.headers["accept-language"] ?? "").split(",")[0].trim().toLowerCase();
    if (preferred !== "" && preferred !== "*") return preferred.startsWith("ja") ? "ja" : "en";
    return options.language;
  };

  /** Only accept requests addressed to this server through a loopback name */
  const isLocalRequest = (req: IncomingMessage): boolean => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    return origin === undefined || allowedHosts.some((host) => origin === `http://${host}`);
  };

  const listSummaries = async (type: SummaryType, from?: string, to?: string): Promise<unknown[]> => {
    if (type === "daily") {
      const rows = await db.getSummariesByRange(from, to);
      return rows.map((row) => ({ type, start: row.date, end: row.date, summary: row.summary }));
    }
    const rows = await db.getPeriodSummariesByRange(type, from, to);
    return rows.map((row) => ({ type, start: row.period_start, end: row.period_end, summary: row.summary }));
  };

  /** Load one report (which may not be saved yet) with its date range */
  const getReport = async (type: SummaryType, date: string): Promise<Record<string, unknown>> => {
    if (type === "daily") {
      const row = await db.getSummaryByDate(date);
      return {
        type,
        start: date,
        end: date,
        summary: row?.summary ?? null,
        text: row ? markdownToPlainText(row.summary) : null,
        next_plan: row?.next_plan ?? null,
        activities: await db.getActivitiesByDate(date),
      };
    }
    // A saved report is addressed by its own start date; this keeps weekly
    // reports reachable after the week_start setting has been changed.
    const saved = await db.getPeriodSummary(type, date);
    const range = saved
      ? { start: saved.period_start, end: saved.period_end }
      : getPeriodRange(type, date, await db.getWeekStart());
    const row = saved ?? (await db.getPeriodSummary(type, range.start));
    return {
      type,
      start: range.start,
      end: row?.period_end ?? range.end,
      summary: row?.summary ?? null,
      text: row ? markdownToPlainText(row.summary) : null,
    };
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const params = url.searchParams;
    const language = resolveLanguage(req, url);
    if (req.method === "PUT" && !(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case "GET /api/meta":
        return sendJson(res, 200, {
          version: PACKAGE_VERSION,
          language,
          messages: getUiMessages(language),
          today: formatLocalDate(),
          weekStart: await db.getWeekStart(),
          projects: await db.listProjects(),
          tags: await db.listTags(),
          activityTypes: ACTIVITY_TYPES,
          briefing: await getBriefing(db, formatLocalDate()),
        });

      case "GET /api/summaries":
        return sendJson(res, 200, {
          items: await listSummaries(summaryType(params.get("type")), dateParam(params, "from"), dateParam(params, "to")),
        });

      case "GET /api/report":
        return sendJson(res, 200, await getReport(summaryType(params.get("type")), requiredDate(params.get("date"), "date")));

      case "PUT /api/report": {
        const body = await readJsonBody(req);
        const type = summaryType(body.type);
        const date = requiredDate(body.date, "date");
        const summary = typeof body.summary === "string" ? body.summary.trim() : "";
        if (summary === "") throw new HttpError(400, "Summary must not be empty");
        if (summary.length > MAX_SUMMARY_LENGTH) throw new HttpError(413, "Summary too long");

        if (type === "daily") {
          // `next_plan` is only changed when the client sends it
          const nextPlan = typeof body.next_plan === "string" ? body.next_plan.slice(0, MAX_SUMMARY_LENGTH) : undefined;
          await db.upsertSummary(date, summary, nextPlan);
        } else {
          const existing = await db.getPeriodSummary(type, date);
          const range = existing
            ? { start: existing.period_start, end: existing.period_end }
            : getPeriodRange(type, date, await db.getWeekStart());
          await db.upsertPeriodSummary(type, range.start, range.end, summary);
        }
        return sendJson(res, 200, await getReport(type, date));
      }

      case "GET /api/activities": {
        const tag = params.get("tag");
        return sendJson(res, 200, {
          items: await db.getActivitiesByRange(
            dateParam(params, "from") ?? "0000-01-01",
            dateParam(params, "to") ?? "9999-12-31",
            { project: params.get("project") ?? undefined, tags: tag ? [tag] : undefined }
          ),
        });
      }

      case "PUT /api/activity": {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Invalid id");

        const label = (value: unknown, name: string): string => {
          if (typeof value !== "string" || value.trim().length > MAX_LABEL_LENGTH) throw new HttpError(400, `Invalid ${name}`);
          return value;
        };
        const changes: Parameters<typeof db.updateActivity>[1] = {};
        if (body.type !== undefined) {
          if (!(ACTIVITY_TYPES as readonly unknown[]).includes(body.type)) throw new HttpError(400, "Invalid type");
          changes.type = body.type as string;
        }
        if (body.content !== undefined) {
          if (typeof body.content !== "string" || body.content.trim() === "") throw new HttpError(400, "Content must not be empty");
          if (body.content.length > MAX_SUMMARY_LENGTH) throw new HttpError(413, "Content too long");
          changes.content = body.content.trim();
        }
        if (body.project !== undefined) changes.project = label(body.project, "project");
        if (body.tags !== undefined) {
          if (!Array.isArray(body.tags) || body.tags.length > 20) throw new HttpError(400, "Invalid tags");
          changes.tags = normalizeTags(body.tags.map((tag) => label(tag, "tag")));
        }
        if (body.minutes !== undefined) {
          const minutes = body.minutes === null ? 0 : Number(body.minutes);
          if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new HttpError(400, "Invalid minutes");
          changes.minutes = minutes === 0 ? null : minutes;
        }

        const { activity } = await db.updateActivity(id, changes);
        if (!activity) throw new HttpError(404, "Not found");
        return sendJson(res, 200, activity);
      }

      case "DELETE /api/activity": {
        const id = Number(params.get("id"));
        if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Invalid id");
        if (!(await db.deleteActivity(id))) throw new HttpError(404, "Not found");
        return sendJson(res, 200, { deleted: id });
      }

      case "GET /api/search": {
        const query = (params.get("q") ?? "").trim();
        if (query === "" || query.length > 200) throw new HttpError(400, "Invalid query");
        return sendJson(res, 200, await db.search(query, { from: dateParam(params, "from"), to: dateParam(params, "to"), limit: 100 }));
      }

      case "GET /api/stats": {
        const today = formatLocalDate();
        const tag = params.get("tag");
        return sendJson(
          res,
          200,
          await db.getStats(dateParam(params, "from") ?? `${today.slice(0, 7)}-01`, dateParam(params, "to") ?? today, {
            project: params.get("project") ?? undefined,
            tags: tag ? [tag] : undefined,
          })
        );
      }

      case "GET /api/export": {
        const format = params.get("format") ?? "markdown";
        const type = params.get("type") ?? "all";
        if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new HttpError(400, "Invalid format");
        if (!(EXPORT_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Invalid type");

        const result = await buildExport(
          db,
          {
            format: format as ExportFormat,
            type: type as ExportType,
            from: dateParam(params, "from"),
            to: dateParam(params, "to"),
            includeLogs: params.get("logs") === "1",
          },
          translators[language]
        );
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": result.mimeType,
          "Content-Disposition": `attachment; filename="${result.filename}"`,
        });
        res.end(result.content);
        return;
      }

      default:
        throw new HttpError(404, "Not found");
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLocalRequest(req)) throw new HttpError(403, "Forbidden");

      const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }

      const asset = STATIC_FILES[url.pathname];
      if (!asset || (req.method !== "GET" && req.method !== "HEAD")) throw new HttpError(404, "Not found");
      let content = await readFile(new URL(`./public/${asset.file}`, import.meta.url));
      if (asset.file === "index.html") {
        // Set the page language before any script runs (WCAG 3.1.1)
        content = Buffer.from(content.toString("utf8").replace('<html lang="en"', `<html lang="${resolveLanguage(req, url)}"`));
      }
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        console.error("Remem dashboard error:", error);
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  };

  const server: Server = createServer((req, res) => void handle(req, res));

  const listen = (requestedPort: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(requestedPort, HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });

  try {
    await listen(options.port ?? DEFAULT_PORT);
  } catch (error) {
    const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (!inUse || !options.fallbackToFreePort) throw error;
    await listen(0);
  }

  port = (server.address() as AddressInfo).port;

  return {
    url: `http://localhost:${port}/`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
