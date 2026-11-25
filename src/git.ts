/**
 * Imports Git commits as activity logs, so work is recorded even when
 * nobody remembered to log it.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { RememDatabase } from "./database.js";
import { formatLocalDate, formatLocalTimestamp, isValidCalendarDate } from "./utils.js";

const run = promisify(execFile);

const FIELD = "\x1f";
const RECORD = "\x1e";

export interface GitImportOptions {
  /** Path of the repository (default: current directory) */
  repoPath?: string;
  /** First date to import, YYYY-MM-DD (default: today) */
  since?: string;
  /** Project name for the imported logs (default: repository folder name) */
  project?: string;
  /** Import commits of every author instead of only the repository's configured user */
  allAuthors?: boolean;
}

export interface GitImportResult {
  repository: string;
  project: string;
  since: string;
  imported: number;
  /** Commits that were already imported earlier */
  skipped: number;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  // No shell is involved, so arguments cannot be interpreted as commands
  const { stdout } = await run("git", ["-C", repoPath, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Import the commits of a repository as "work" logs; each commit is imported only once */
export async function importGitCommits(db: RememDatabase, options: GitImportOptions = {}): Promise<GitImportResult> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Not a directory: ${repoPath}`);
  }

  const since = options.since ?? formatLocalDate();
  if (!isValidCalendarDate(since)) throw new Error(`Invalid date: ${since}`);

  let root: string;
  try {
    root = (await git(repoPath, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error(`Not a Git repository: ${repoPath}`);
  }

  const args = ["log", "--no-merges", `--since=${since}T00:00:00`, `--pretty=format:%H${FIELD}%aI${FIELD}%s${RECORD}`];
  if (!options.allAuthors) {
    const email = (await git(repoPath, ["config", "user.email"]).catch(() => "")).trim();
    if (email) args.push(`--author=${email}`, "--fixed-strings");
  }

  const project = options.project?.trim() || basename(root);
  const commits = (await git(repoPath, args))
    .split(RECORD)
    .map((record) => record.trim().split(FIELD))
    .filter((fields) => fields.length === 3)
    .reverse(); // oldest first

  let imported = 0;
  let skipped = 0;
  for (const [hash, authoredAt, subject] of commits) {
    const result = await db.insertActivity("work", `${subject} (${hash.slice(0, 7)})`, {
      project,
      tags: ["git"],
      source: `git:${hash}`,
      timestamp: formatLocalTimestamp(new Date(authoredAt)),
    });
    if (result.duplicate) skipped += 1;
    else imported += 1;
  }

  return { repository: root, project, since, imported, skipped };
}
