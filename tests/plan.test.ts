import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RememDatabase } from "../src/database.js";
import { extractPlan, getBriefing, takeDailyBriefing } from "../src/plan.js";
import { markdownToPlainText } from "../src/plaintext.js";
import { createTestDatabase } from "./helpers.js";

describe("extractPlan", () => {
  it("finds the plan section under common headings", () => {
    expect(extractPlan("## 日報\n### 🎯 実施内容\n- A\n### 🔭 明日の予定\n- B\n- C\n### メモ\n- D")).toBe("- B\n- C");
    expect(extractPlan("## Daily\n### Done\n- A\n### Next steps\n- B")).toBe("- B");
    expect(extractPlan("# Report\n## Plan for tomorrow\n1. X\n### detail\n- y\n## Notes\nz")).toBe("1. X\n### detail\n- y");
    expect(extractPlan("### 次回やること\n- 計測")).toBe("- 計測");
  });

  it("returns null when there is no plan", () => {
    expect(extractPlan("## 日報\n- 予定どおり完了")).toBeNull();
    expect(extractPlan("### 明日の予定\n\n### メモ\n- x")).toBeNull();
    expect(extractPlan("```\n### 明日の予定\n- in code\n```")).toBeNull();
  });
});

describe("daily briefing", () => {
  let db: RememDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDatabase());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("prefers the stored plan over the report text", async () => {
    await db.upsertSummary("2026-01-20", "### 明日の予定\n- from text", "- stored plan");
    expect(await getBriefing(db, "2026-01-21")).toEqual({ date: "2026-01-20", plan: "- stored plan" });
  });

  it("falls back to the plan section of the latest earlier report", async () => {
    await db.upsertSummary("2026-01-16", "### 明日の予定\n- friday plan");
    await db.upsertSummary("2026-01-21", "### 明日の予定\n- same day, must be ignored");
    // The following Monday still gets Friday's plan
    expect(await getBriefing(db, "2026-01-19")).toEqual({ date: "2026-01-16", plan: "- friday plan" });
    expect(await getBriefing(db, "2026-01-16")).toBeNull();
  });

  it("ignores plans that are too old or missing", async () => {
    await db.upsertSummary("2026-01-01", "report", "- old plan");
    expect(await getBriefing(db, "2026-01-15")).not.toBeNull();
    expect(await getBriefing(db, "2026-01-16")).toBeNull();

    await db.upsertSummary("2026-02-01", "no plan here");
    expect(await getBriefing(db, "2026-02-02")).toBeNull();
  });

  it("is handed out once per day", async () => {
    await db.upsertSummary("2026-01-20", "report", "- plan");
    expect(await takeDailyBriefing(db, "2026-01-21")).toEqual({ date: "2026-01-20", plan: "- plan" });
    expect(await takeDailyBriefing(db, "2026-01-21")).toBeNull();
    expect(await takeDailyBriefing(db, "2026-01-22")).not.toBeNull();
  });

  it("keeps or clears the stored plan as asked", async () => {
    await db.upsertSummary("2026-01-20", "v1", "- plan");
    await db.upsertSummary("2026-01-20", "v2");
    expect((await db.getSummaryByDate("2026-01-20"))?.next_plan).toBe("- plan");
    await db.upsertSummary("2026-01-20", "v3", "");
    expect((await db.getSummaryByDate("2026-01-20"))?.next_plan).toBeNull();
  });
});

describe("markdownToPlainText", () => {
  it("turns a report into text that reads well without Markdown", () => {
    const text = markdownToPlainText(
      "## 本日の報告\n\n### 実施内容\n- **検索機能**を実装 (`OrderSearch`)\n  - 条件の保存\n- [設計メモ](https://example.com/spec)を更新\n\n> 懸念あり\n\n---\n\n```\nnpm test\n```\n1. 一つ目"
    );
    expect(text).toBe(
      "■ 本日の報告\n\n◆ 実施内容\n・検索機能を実装 (OrderSearch)\n  ・条件の保存\n・設計メモ (https://example.com/spec)を更新\n\n  懸念あり\n\n────────────────\n\n    npm test\n1. 一つ目"
    );
  });

  it("keeps plain text unchanged", () => {
    expect(markdownToPlainText("just a line\nand another")).toBe("just a line\nand another");
  });
});
