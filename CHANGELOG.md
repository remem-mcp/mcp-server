# Changelog

All notable changes to this project are documented in this file.

## 2.0.0

### Added

- **Web dashboard** (`remem ui`, or the `open_dashboard` tool): browse, write and edit daily, weekly and monthly reports, filter activity logs, and export. It listens on `127.0.0.1` only and is built to meet WCAG 2.1 AA.
- **Printable business documents**: reports can be previewed and printed on A4 (or saved as PDF) as a formal work report, with a choice of style (business document, standard, compact) and typeface, name and department fields, approval boxes, emoji removal and page breaks.
- **Dashboard language**: follows the browser's language, with a language switch in the header; dates are formatted for the chosen language.
- **Daily briefing**: `save_summary` accepts `next_plan`; the first Remem tool call of a following day returns that plan, `get_briefing` returns it on request, `prepare_report` includes it, and the dashboard shows it. A `start_day` prompt starts the day.
- **Time tracking and statistics**: `log` accepts `minutes`; `get_stats` and the dashboard's statistics view add up entries and time by project, type, tag and day; reports include the time spent.
- **One-command setup**: `remem setup` registers Remem with Claude Code, Claude Desktop and Codex without replacing existing entries, with a backup and a `--dry-run` mode. `--hooks` installs Claude Code hooks that show the daily briefing at session start (`remem briefing`) and record commits at session end.
- **Search**: the `search` tool and a dashboard search view find logs and reports by keyword, best matches first, and fall back to partial matches when nothing contains every word.
- **Editing logs**: `update_log`, `delete_log`, back-dated entries (`date`, `time`), and editing in the dashboard.
- **Git import**: `import_git_commits` and `remem import-commits` record commits as logs, once each.
- **Secret masking**: values that look like passwords, tokens or keys are replaced with `[REDACTED]` before logs and reports are saved.
- **Structured tool results** for clients that read data, next to the text.
- **Sharing**: `get_report` and `export` can produce plain text for chat and e-mail; the dashboard can copy a report as text.
- **Command line**: `remem setup`, `remem log`, `remem import-commits`, `remem briefing`, `remem backup` and `remem restore`.
- `mcpName` in `package.json`, so the package can be listed in the MCP Registry.
- **Weekly and monthly reports**: `prepare_period_report` and `save_period_summary` tools, `weekly_template` / `monthly_template` / `week_start` settings, and a `type` option for `get_history`.
- **Projects and tags**: `log` accepts `project` and `tags`; `prepare_report` can filter by them; `list_tags` lists what is in use.
- **Export**: the `export` tool writes Markdown or JSON files to `~/.remem/exports/`. PDF is available through the dashboard's print preview.
- `REMEM_DATA_DIR`, `REMEM_LANG` and `REMEM_UI_PORT` environment variables.
- `remem --help` and `remem --version`.
- **Easier to use from any MCP client** (Claude, Codex, Muse Code and others): the server sends usage instructions when a client connects, offers `daily_report`, `weekly_report`, `monthly_report` and `log_session` prompts, describes each tool's role in the workflow, and points to the next step after preparing a report.
- Tool titles and annotations (read-only / destructive hints) for MCP clients.
- Setup instructions for Claude Code, Claude Desktop and Codex.

### Changed

- The database schema is upgraded automatically on first start (new columns for projects, tags, time and plans; new `period_summaries` table). Existing data is kept. **A database opened by 2.0.0 should not be used with 1.x afterwards.**
- Language detection also checks `LC_ALL`, `LC_MESSAGES` and the operating system locale, so Japanese is detected on Windows.
- The server shuts down cleanly when the MCP client closes the connection.
- `prepare_report` returns `project` and `tags` for each log entry.
- Node.js 22 or later is supported (previously 24 or later). CI runs on Node.js 22, 24 and 26.

### Removed

- Unused internal modules and exports (`src/types.ts`, `getT`, `getCurrentLanguage`).

### Fixed

- Activities were assigned to the wrong date because of a double timezone conversion (for example, logs after 15:00 JST appeared on the next day).
- `retention_days` accepted values such as `30abc`; impossible dates such as `2026-13-45` were accepted.
- Security advisories in dependencies (`npm audit` reports 0 vulnerabilities).
