import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";

import type { RememDatabase } from "../src/database.js";
import { startWebServer, type WebServerHandle } from "../src/web/server.js";
import { addDays, formatLocalDate } from "../src/utils.js";
import { createTestDatabase, insertAt } from "./helpers.js";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("web dashboard server", () => {
  let db: RememDatabase;
  let cleanup: () => Promise<void>;
  let server: WebServerHandle;

  /** Low-level request so that Host and Origin headers can be forged */
  const raw = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path, method: options.method ?? "GET", headers: options.headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
          );
        }
      );
      req.on("error", reject);
      req.end(options.body);
    });

  const getJson = async <T>(path: string): Promise<T> => {
    const response = await fetch(new URL(path, server.url));
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };

  const put = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }): Promise<Response> =>
    fetch(new URL("/api/report", server.url), { method: "PUT", headers, body: JSON.stringify(body) });

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDatabase());
    server = await startWebServer(db, { port: 0, language: "ja" });
  });

  afterEach(async () => {
    await server.close();
    await cleanup();
  });

  it("serves the page in the configured language with security headers", async () => {
    const response = await fetch(server.url);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<html lang="ja"');
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    for (const asset of ["/app.js", "/markdown.js", "/styles.css"]) {
      expect((await fetch(new URL(asset, server.url))).status).toBe(200);
    }
  });

  it("follows the language of the browser or the one chosen in the dashboard", async () => {
    const localHost = `localhost:${server.port}`;
    const page = async (acceptLanguage?: string): Promise<string> =>
      (await raw("/", { headers: { Host: localHost, ...(acceptLanguage ? { "Accept-Language": acceptLanguage } : {}) } })).body;

    // Browser language wins over the server default ("ja" in this test)
    expect(await page("en-US,en;q=0.9")).toContain('<html lang="en"');
    expect(await page("ja,en-US;q=0.8")).toContain('<html lang="ja"');
    expect(await page("fr-FR,fr;q=0.9")).toContain('<html lang="en"');
    expect(await page()).toContain('<html lang="ja"');

    const meta = async (query: string, acceptLanguage: string): Promise<{ language: string; messages: Record<string, string> }> =>
      JSON.parse((await raw(`/api/meta${query}`, { headers: { Host: localHost, "Accept-Language": acceptLanguage } })).body);

    expect((await meta("", "en-US")).messages.save).toBe("Save");
    // An explicit choice wins over the browser language
    expect(await meta("?lang=ja", "en-US")).toMatchObject({ language: "ja", messages: { save: "保存" } });
    expect((await meta("?lang=xx", "en-US")).language).toBe("en");

    await db.upsertSummary("2026-01-20", "body");
    const exported = await raw("/api/export?format=markdown&lang=en", { headers: { Host: localHost, "Accept-Language": "ja" } });
    expect(exported.body).toContain("## Daily Reports");
  });

  it("does not serve files outside the allow-list", async () => {
    expect((await raw("/../package.json", { headers: { Host: `localhost:${server.port}` } })).status).toBe(404);
    expect((await fetch(new URL("/server.js", server.url))).status).toBe(404);
    expect((await fetch(new URL("/api/unknown", server.url))).status).toBe(404);
  });

  it("rejects requests with a foreign Host or Origin header", async () => {
    const localHost = `127.0.0.1:${server.port}`;
    // DNS rebinding: the browser sends the attacker's host name
    expect((await raw("/api/meta", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await raw("/api/meta", { headers: { Host: `evil.example:${server.port}` } })).status).toBe(403);
    // Cross-site request from another website
    expect((await raw("/api/meta", { headers: { Host: localHost, Origin: "https://evil.example" } })).status).toBe(403);
    const forged = await raw("/api/report", {
      method: "PUT",
      headers: { Host: localHost, Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "daily", date: "2026-01-20", summary: "forged" }),
    });
    expect(forged.status).toBe(403);
    expect(await db.getSummaryByDate("2026-01-20")).toBeUndefined();

    expect((await raw("/api/meta", { headers: { Host: localHost, Origin: `http://${localHost}` } })).status).toBe(200);
  });

  it("returns meta data with messages, projects and tags", async () => {
    await db.insertActivity("work", "A", { project: "Remem", tags: ["review"] });
    const meta = await getJson<{ language: string; messages: Record<string, string>; projects: unknown[]; tags: unknown[]; today: string }>(
      "/api/meta"
    );

    expect(meta.language).toBe("ja");
    expect(meta.messages.save).toBe("保存");
    expect(meta.projects).toEqual([{ name: "Remem", count: 1 }]);
    expect(meta.tags).toEqual([{ name: "review", count: 1 }]);
    expect(meta.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("creates, updates and lists daily reports", async () => {
    await insertAt(db, "2026-01-20 09:00:00", "morning work");

    const empty = await getJson<{ summary: string | null; activities: unknown[] }>("/api/report?type=daily&date=2026-01-20");
    expect(empty.summary).toBeNull();
    expect(empty.activities).toHaveLength(1);

    expect((await put({ type: "daily", date: "2026-01-20", summary: "  first  " })).status).toBe(200);
    const updated = await put({ type: "daily", date: "2026-01-20", summary: "second" });
    expect(((await updated.json()) as { summary: string }).summary).toBe("second");
    expect((await db.getSummaryByDate("2026-01-20"))?.summary).toBe("second");

    const list = await getJson<{ items: { start: string; summary: string }[] }>("/api/summaries?type=daily");
    expect(list.items).toEqual([{ type: "daily", start: "2026-01-20", end: "2026-01-20", summary: "second" }]);
  });

  it("stores weekly and monthly reports under their period", async () => {
    // 2026-01-21 is a Wednesday
    expect((await put({ type: "weekly", date: "2026-01-21", summary: "week" })).status).toBe(200);
    expect((await put({ type: "monthly", date: "2026-01-21", summary: "month" })).status).toBe(200);

    expect((await db.getPeriodSummary("weekly", "2026-01-19"))?.period_end).toBe("2026-01-25");
    expect((await db.getPeriodSummary("monthly", "2026-01-01"))?.period_end).toBe("2026-01-31");

    const report = await getJson<{ start: string; end: string; summary: string }>("/api/report?type=weekly&date=2026-01-25");
    expect(report).toMatchObject({ start: "2026-01-19", end: "2026-01-25", summary: "week" });
  });

  it("keeps saved weekly reports reachable after week_start changes", async () => {
    await put({ type: "weekly", date: "2026-01-21", summary: "monday week" });
    await db.setConfig("week_start", "sunday");

    // The list links to the saved start date (a Monday), which must still open and update that report
    const report = await getJson<{ start: string; end: string; summary: string }>("/api/report?type=weekly&date=2026-01-19");
    expect(report).toMatchObject({ start: "2026-01-19", end: "2026-01-25", summary: "monday week" });

    await put({ type: "weekly", date: "2026-01-19", summary: "edited" });
    expect((await db.getPeriodSummary("weekly", "2026-01-19"))?.summary).toBe("edited");
    expect(await db.getPeriodSummariesByRange("weekly")).toHaveLength(1);
  });

  it("validates input", async () => {
    expect((await put({ type: "daily", date: "2026-13-45", summary: "x" })).status).toBe(400);
    expect((await put({ type: "daily", date: "2026-01-20", summary: "   " })).status).toBe(400);
    expect((await put({ type: "yearly", date: "2026-01-20", summary: "x" })).status).toBe(400);
    expect((await put({ type: "daily", date: "2026-01-20", summary: "x" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(
      (await fetch(new URL("/api/report", server.url), { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" })).status
    ).toBe(400);
    expect((await fetch(new URL("/api/report?type=daily&date=nope", server.url))).status).toBe(400);
    expect((await fetch(new URL("/api/summaries?type=nope", server.url))).status).toBe(400);
    expect((await fetch(new URL("/api/activities?from=2026-99-99", server.url))).status).toBe(400);
    expect((await fetch(new URL("/api/export?format=pdf", server.url))).status).toBe(400);
  });

  it("filters activity logs", async () => {
    await insertAt(db, "2026-01-20 09:00:00", "A", { project: "Remem", tags: ["review"] });
    await insertAt(db, "2026-01-21 09:00:00", "B", { project: "Other", tags: ["docs"] });

    const contents = async (query: string): Promise<string[]> =>
      (await getJson<{ items: { content: string }[] }>(`/api/activities?${query}`)).items.map((item) => item.content);

    expect(await contents("")).toEqual(["A", "B"]);
    expect(await contents("from=2026-01-21&to=2026-01-21")).toEqual(["B"]);
    expect(await contents("project=Remem")).toEqual(["A"]);
    expect(await contents("tag=docs")).toEqual(["B"]);
  });

  it("edits and deletes activity logs", async () => {
    await insertAt(db, "2026-01-20 09:00:00", "tpyo", { project: "Remem", tags: ["a"] });
    const [{ id }] = await db.getActivitiesByDate("2026-01-20");
    const send = (method: string, path: string, body?: unknown): Promise<Response> =>
      fetch(new URL(path, server.url), {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const updated = await send("PUT", "/api/activity", { id, content: " fixed ", type: "memo", tags: ["#b", "b"], minutes: 45, project: "" });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ content: "fixed", type: "memo", tags: ["b"], minutes: 45, project: null });

    expect((await send("PUT", "/api/activity", { id, content: "   " })).status).toBe(400);
    expect((await send("PUT", "/api/activity", { id, type: "party" })).status).toBe(400);
    expect((await send("PUT", "/api/activity", { id, minutes: 5000 })).status).toBe(400);
    expect((await send("PUT", "/api/activity", { id, project: "p".repeat(51) })).status).toBe(400);
    expect((await send("PUT", "/api/activity", { id: 9999, content: "x" })).status).toBe(404);
    expect((await db.getActivity(id))?.content).toBe("fixed");

    expect((await send("DELETE", "/api/activity?id=abc")).status).toBe(400);
    expect((await send("DELETE", `/api/activity?id=${id}`)).status).toBe(200);
    expect((await send("DELETE", `/api/activity?id=${id}`)).status).toBe(404);

    // A cross-site page cannot delete
    await insertAt(db, "2026-01-21 09:00:00", "keep me");
    const [{ id: kept }] = await db.getActivitiesByDate("2026-01-21");
    const forged = await raw(`/api/activity?id=${kept}`, {
      method: "DELETE",
      headers: { Host: `127.0.0.1:${server.port}`, Origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
    expect(await db.getActivity(kept)).toBeDefined();
  });

  it("searches and returns statistics", async () => {
    await db.insertActivity("work", "検索機能を実装", { project: "Remem", minutes: 60, timestamp: "2026-01-20 09:00:00" });
    await db.insertActivity("work", "ドキュメント更新", { project: "Docs", minutes: 30, timestamp: "2026-01-21 09:00:00" });
    await db.upsertSummary("2026-01-20", "検索機能のレビュー");

    const found = await getJson<{ activities: unknown[]; daily: unknown[] }>(`/api/search?q=${encodeURIComponent("検索")}`);
    expect(found.activities).toHaveLength(1);
    expect(found.daily).toHaveLength(1);
    expect((await fetch(new URL("/api/search?q=", server.url))).status).toBe(400);

    const stats = await getJson<{ count: number; minutes: number; byProject: { name: string }[] }>(
      "/api/stats?from=2026-01-01&to=2026-01-31"
    );
    expect(stats).toMatchObject({ count: 2, minutes: 90 });
    expect(stats.byProject.map((group) => group.name)).toEqual(["Remem", "Docs"]);
    expect((await getJson<{ count: number }>("/api/stats?from=2026-01-01&to=2026-01-31&project=Docs")).count).toBe(1);
  });

  it("stores the plan with a daily report and offers it as today's briefing", async () => {
    const yesterday = addDays(formatLocalDate(), -1);
    expect((await getJson<{ briefing: unknown }>("/api/meta")).briefing).toBeNull();

    expect((await put({ type: "daily", date: yesterday, summary: "## Report\n- **done**", next_plan: "- tomorrow's task" })).status).toBe(200);
    const report = await getJson<{ next_plan: string; text: string }>(`/api/report?type=daily&date=${yesterday}`);
    expect(report.next_plan).toBe("- tomorrow's task");
    expect(report.text).toBe("■ Report\n・done");

    expect((await getJson<{ briefing: unknown }>("/api/meta")).briefing).toEqual({ date: yesterday, plan: "- tomorrow's task" });

    // Saving without next_plan keeps the stored plan
    await put({ type: "daily", date: yesterday, summary: "edited" });
    expect((await db.getSummaryByDate(yesterday))?.next_plan).toBe("- tomorrow's task");
  });

  it("downloads exports as attachments", async () => {
    await db.upsertSummary("2026-01-20", "report body");

    const markdown = await fetch(new URL("/api/export?format=markdown", server.url));
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("content-disposition")).toMatch(/^attachment; filename="remem-export-[\d-]+\.md"$/);
    expect(await markdown.text()).toContain("report body");

    const plain = await fetch(new URL("/api/export?format=text", server.url));
    expect(plain.headers.get("content-type")).toContain("text/plain");
    expect(plain.headers.get("content-disposition")).toMatch(/\.txt"$/);

    const json = await fetch(new URL("/api/export?format=json&type=daily", server.url));
    expect(((await json.json()) as { daily: unknown[] }).daily).toHaveLength(1);
  });

  it("falls back to a free port when the requested one is taken", async () => {
    await expect(startWebServer(db, { port: server.port, language: "en" })).rejects.toThrow();

    const second = await startWebServer(db, { port: server.port, fallbackToFreePort: true, language: "en" });
    try {
      expect(second.port).not.toBe(server.port);
      expect((await fetch(second.url)).status).toBe(200);
    } finally {
      await second.close();
    }
  });
});
