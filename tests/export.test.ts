import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RememDatabase } from "../src/database.js";
import { buildExport, demoteHeadings, writeExportFile } from "../src/export.js";
import { initI18n } from "../src/i18n.js";
import { createTestDatabase, insertAt } from "./helpers.js";

describe("export", () => {
  let db: RememDatabase;
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, dir, cleanup } = await createTestDatabase());
    await db.upsertSummary("2026-01-20", "## Daily\n- did things");
    await db.upsertSummary("2026-02-03", "February day");
    await db.upsertPeriodSummary("weekly", "2026-01-19", "2026-01-25", "Week four");
    await db.upsertPeriodSummary("monthly", "2026-01-01", "2026-01-31", "January month");
    await insertAt(db, "2026-01-20 09:30:00", "Reviewed PR\nsecond line", { project: "Remem", tags: ["review"] });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("renders all reports as Markdown with nested headings", async () => {
    const t = await initI18n("en");
    const result = await buildExport(db, {}, t);

    expect(result.count).toBe(4);
    expect(result.filename).toMatch(/^remem-export-\d{8}-\d{6}\.md$/);
    expect(result.content).toContain("# Remem Export");
    expect(result.content).toContain("## Daily Reports");
    expect(result.content).toContain("### 2026-01-20");
    // The report's own "##" heading is nested below the date heading
    expect(result.content).toContain("##### Daily");
    expect(result.content).toContain("## Weekly Reports");
    expect(result.content).toContain("### 2026-01-19 – 2026-01-25");
    expect(result.content).toContain("## Monthly Reports");
    expect(result.content).not.toContain("Activity Logs");
  });

  it("limits the export by type and date range", async () => {
    const t = await initI18n("en");
    const daily = await buildExport(db, { type: "daily", from: "2026-02-01", to: "2026-02-28" }, t);

    expect(daily.count).toBe(1);
    expect(daily.content).toContain("February day");
    expect(daily.content).not.toContain("did things");
    expect(daily.content).not.toContain("Weekly Reports");
    expect(daily.content).toContain("Range: 2026-02-01 to 2026-02-28");
  });

  it("includes activity logs on request", async () => {
    const t = await initI18n("en");
    const result = await buildExport(db, { includeLogs: true }, t);

    expect(result.content).toContain("## Activity Logs");
    expect(result.content).toContain("- 2026-01-20 09:30:00 [work] (Remem) Reviewed PR second line #review");
  });

  it("produces JSON and localized Markdown", async () => {
    const json = await buildExport(db, { format: "json", includeLogs: true }, await initI18n("en"));
    const parsed = JSON.parse(json.content) as { daily: unknown[]; weekly: unknown[]; activities: { tags: string[] }[] };
    expect(json.filename).toMatch(/\.json$/);
    expect(parsed.daily).toHaveLength(2);
    expect(parsed.weekly).toHaveLength(1);
    expect(parsed.activities[0].tags).toEqual(["review"]);

    const ja = await buildExport(db, {}, await initI18n("ja"));
    expect(ja.content).toContain("## 日報");
    expect(ja.content).toContain("## 週報");
  });

  it("writes the export into the exports folder of the data directory", async () => {
    const path = writeExportFile(dir, "remem-export-test.md", "# test\n");
    expect(path).toBe(join(dir, "exports", "remem-export-test.md"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("# test\n");
  });

  it("demotes headings but leaves fenced code untouched", () => {
    const input = "# Title\ntext #notheading\n```\n# comment in code\n```\n###### deep";
    expect(demoteHeadings(input, 2)).toBe("### Title\ntext #notheading\n```\n# comment in code\n```\n###### deep");
  });
});
