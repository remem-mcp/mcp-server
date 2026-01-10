<div align="center">

<img src="https://raw.githubusercontent.com/remem-mcp/mcp-server/refs/heads/main/assets/logo.svg" alt="Remem Logo" width="120" />

# Remem

**Log your day. Generate reports. Reflect anytime.**

[![npm version](https://img.shields.io/npm/v/@remem/mcp-server.svg)](https://www.npmjs.com/package/@remem/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-green.svg)](https://nodejs.org/)

[日本語](https://github.com/remem-mcp/mcp-server/blob/main/README.ja.md)

</div>

---

## Overview

**Remem** is a local-first MCP (Model Context Protocol) server that captures your daily activities, generates structured reports, and preserves summaries for long-term reflection.

- 📝 **Log** — Record your work, decisions, and memos throughout the day
- 📊 **Generate** — Create daily reports from your activity logs  
- 💾 **Reflect** — Review past entries weeks or months later
- 🔒 **Local storage** — Everything stored in SQLite

---

## Quick Start

Add Remem to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "remem": {
      "command": "npx",
      "args": ["-y", "@remem/mcp-server"]
    }
  }
}
```

<details>
<summary>📁 Configuration file location</summary>

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

</details>

---

## Features

| Feature | Description |
|---------|-------------|
| **Activity Logging** | Record work, decisions, memos, and approvals as you go |
| **Smart Reports** | Generate daily reports with customizable templates |
| **Long-term Memory** | Summaries are preserved indefinitely for future reflection |
| **Auto Cleanup** | Detailed logs expire after configurable days (default: 30) |
| **Multi-language** | Automatically adapts to your system language (EN/JA) |
| **Privacy First** | All data stored locally in `~/.remem/remem.db` |

---

## Tools

Remem provides the following MCP tools:

### `log`
Record an activity to the database.

```
Type: work | decision | memo | approval
Content: Description of the activity
```

### `prepare_report`
Gather logs and prepare data for AI to generate a daily report.

### `save_summary`
Save the generated report summary to long-term storage.

### `get_history`
Retrieve past summaries for reflection (default: last 6 months).

### `configure`
Update server settings like `retention_days` or `default_template`.

### `get_config`
View current server configuration.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Day                             │
├─────────────────────────────────────────────────────────────┤
│  9:00  "Reviewed PR #123"           → log(work, ...)       │
│ 11:00  "Decided to use Kysely"      → log(decision, ...)   │
│ 15:00  "Approved deployment"        → log(approval, ...)   │
│ 18:00  "Generate today's report"    → prepare_report()     │
│         AI writes report            → save_summary()       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    ~/.remem/remem.db                        │
├─────────────────────────────────────────────────────────────┤
│  activities (expires after 30 days)                        │
│  daily_summaries (permanent)                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   6 Months Later                            │
├─────────────────────────────────────────────────────────────┤
│  "What did I work on last quarter?"                        │
│  → get_history(months: 6)                                  │
│  → AI summarizes your growth and achievements              │
└─────────────────────────────────────────────────────────────┘
```

---

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `retention_days` | `30` | Days to keep detailed activity logs |
| `default_template` | (built-in) | Markdown template for daily reports |

Configure via the `configure` tool or edit `~/.remem/remem.db` directly.

---

## Development

```bash
# Clone the repository
git clone https://github.com/remem-mcp/remem.git
cd remem

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run locally
node build/index.js
```

### Tech Stack

- **Runtime**: Node.js 24+
- **Language**: TypeScript
- **Database**: SQLite (via Kysely + better-sqlite3)
- **Protocol**: MCP SDK
- **i18n**: i18next
- **Testing**: Vitest

---

## Roadmap

- [ ] Web UI for browsing history
- [ ] Export to Markdown/PDF
- [ ] Team sync via cloud storage
- [ ] More languages (zh, ko, es, ...)
- [ ] VS Code extension integration

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes using [Conventional Commits](https://www.conventionalcommits.org/)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Message Format

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Please use the following format:

```
<type>: <description>

[optional body]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

**Examples:**
```
feat: add weekly summary generation
fix: correct date parsing in prepare_report
docs: update installation instructions
```

---

## License

MIT © [Remem Contributors](https://github.com/remem-mcp)

---

<div align="center">

**[⬆ Back to Top](#remem)**

</div>
