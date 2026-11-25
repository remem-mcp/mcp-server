import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackup, readBackupFile, restoreBackup } from "../src/backup.js";
import type { RememDatabase } from "../src/database.js";
import { importGitCommits } from "../src/git.js";
import { createTestDatabase } from "./helpers.js";

describe("importGitCommits", () => {
  let db: RememDatabase;
  let cleanup: () => Promise<void>;
  let repo: string;

  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  };
  const commit = (message: string, author = "me@example.com"): void => {
    writeFileSync(join(repo, "file.txt"), `${message}\n`, { flag: "a" });
    git("add", ".");
    git("-c", `user.email=${author}`, "-c", "user.name=Tester", "-c", "commit.gpgsign=false", "commit", "-m", message);
  };

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDatabase());
    repo = mkdtempSync(join(tmpdir(), "remem-repo-"));
    git("init", "-q");
    git("config", "user.email", "me@example.com");
    git("config", "user.name", "Tester");
  });

  afterEach(async () => {
    await cleanup();
    rmSync(repo, { recursive: true, force: true });
  });

  it("imports the user's commits once, oldest first", async () => {
    commit("feat: add search");
    commit("fix: someone else's change", "other@example.com");
    commit("docs: update readme; rm -rf $(echo x)");

    const first = await importGitCommits(db, { repoPath: repo, project: "Remem" });
    expect(first).toMatchObject({ imported: 2, skipped: 0, project: "Remem" });

    const logs = await db.getActivitiesByRange("0000-01-01", "9999-12-31");
    expect(logs.map((log) => log.content.replace(/ \([0-9a-f]{7}\)$/, ""))).toEqual([
      "feat: add search",
      "docs: update readme; rm -rf $(echo x)",
    ]);
    expect(logs[0]).toMatchObject({ type: "work", project: "Remem", tags: ["git"] });

    const second = await importGitCommits(db, { repoPath: repo, project: "Remem" });
    expect(second).toMatchObject({ imported: 0, skipped: 2 });
    expect(await db.getActivitiesByRange("0000-01-01", "9999-12-31")).toHaveLength(2);
  });

  it("can include other authors and defaults the project to the folder name", async () => {
    commit("feat: mine");
    commit("feat: theirs", "other@example.com");
    const result = await importGitCommits(db, { repoPath: repo, allAuthors: true });
    expect(result.imported).toBe(2);
    expect(result.project).toMatch(/^remem-repo-/);
  });

  it("rejects paths that are not repositories and invalid dates", async () => {
    const plain = mkdtempSync(join(tmpdir(), "remem-plain-"));
    try {
      await expect(importGitCommits(db, { repoPath: plain })).rejects.toThrow("Not a Git repository");
      await expect(importGitCommits(db, { repoPath: join(plain, "missing") })).rejects.toThrow("Not a directory");
      await expect(importGitCommits(db, { repoPath: repo, since: "--output=/tmp/x" })).rejects.toThrow("Invalid date");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("backup and restore", () => {
  it("restores everything into an empty database without duplicating on a second run", async () => {
    const source = await createTestDatabase();
    const target = await createTestDatabase();
    try {
      await source.db.insertActivity("work", "A", { project: "Remem", tags: ["x"], minutes: 30, timestamp: "2026-01-20 09:00:00" });
      await source.db.insertActivity("memo", "B", { timestamp: "2026-01-20 10:00:00" });
      await source.db.upsertSummary("2026-01-20", "daily", "- plan");
      await source.db.upsertPeriodSummary("weekly", "2026-01-19", "2026-01-25", "weekly");
      await source.db.upsertPeriodSummary("monthly", "2026-01-01", "2026-01-31", "monthly");

      const file = join(source.dir, "backup.json");
      writeFileSync(file, JSON.stringify(await createBackup(source.db)));
      const backup = readBackupFile(file);

      expect(await restoreBackup(target.db, backup)).toEqual({ activities: 2, summaries: 3, skipped: 0 });
      expect(await restoreBackup(target.db, backup)).toEqual({ activities: 0, summaries: 0, skipped: 5 });

      const [first] = await target.db.getActivitiesByDate("2026-01-20");
      expect(first).toMatchObject({ content: "A", project: "Remem", tags: ["x"], minutes: 30, ts: "2026-01-20 09:00:00" });
      expect(await target.db.getSummaryByDate("2026-01-20")).toMatchObject({ summary: "daily", next_plan: "- plan" });
      expect((await target.db.getPeriodSummary("monthly", "2026-01-01"))?.summary).toBe("monthly");
    } finally {
      await source.cleanup();
      await target.cleanup();
    }
  });

  it("keeps existing reports unless asked to overwrite, and rejects other files", async () => {
    const { db, dir, cleanup } = await createTestDatabase();
    try {
      await db.upsertSummary("2026-01-20", "current");
      const backup = { format: "remem-backup", version: 1, daily: [{ date: "2026-01-20", summary: "from backup" }, { date: "bad", summary: "x" }] };

      expect((await restoreBackup(db, backup)).skipped).toBe(1);
      expect((await db.getSummaryByDate("2026-01-20"))?.summary).toBe("current");
      expect((await restoreBackup(db, backup, { overwrite: true })).summaries).toBe(1);
      expect((await db.getSummaryByDate("2026-01-20"))?.summary).toBe("from backup");

      const other = join(dir, "other.json");
      writeFileSync(other, JSON.stringify({ hello: "world" }));
      expect(() => readBackupFile(other)).toThrow("not a Remem backup");
      writeFileSync(other, "not json");
      expect(() => readBackupFile(other)).toThrow("Could not read");
    } finally {
      await cleanup();
    }
  });
});
