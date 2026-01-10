<div align="center">

<img src="./assets/logo.svg" alt="Remem ロゴ" width="120" />

# Remem

**記録する。日報を作る。いつでも振り返る。**

[![npm version](https://img.shields.io/npm/v/@remem/mcp-server.svg)](https://www.npmjs.com/package/@remem/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-green.svg)](https://nodejs.org/)

[English](./README.md)

</div>

---

## 概要

**Remem** は、日々の活動を記録し、日報を自動生成し、長期間の振り返りを可能にするローカルファーストのMCP（Model Context Protocol）サーバーです。

- 📝 **記録** — 一日を通して作業、決定、メモを残す
- 📊 **日報生成** — 活動ログから自動で日報を作成
- 💾 **振り返り** — 数週間後、数ヶ月後でも過去を参照
- 🔒 **ローカル保存** — すべてSQLiteに保存

---

## クイックスタート

Claude Desktopの設定にRememを追加します：

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
<summary>📁 設定ファイルの場所</summary>

| OS | パス |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

</details>

---

## 機能

| 機能 | 説明 |
|------|------|
| **アクティビティ記録** | 作業、決定、メモ、承認をリアルタイムで記録 |
| **スマート日報** | カスタマイズ可能なテンプレートで日報を生成 |
| **長期記憶** | 要約は永続保存され、将来の振り返りが可能 |
| **自動クリーンアップ** | 詳細ログは設定日数後に自動削除（デフォルト: 30日） |
| **多言語対応** | システム言語に自動適応（日本語/英語） |
| **プライバシー優先** | すべてのデータは `~/.remem/remem.db` にローカル保存 |

---

## ツール

Rememは以下のMCPツールを提供します：

### `log`
アクティビティをデータベースに記録します。

```
Type: work | decision | memo | approval
Content: アクティビティの説明
```

### `prepare_report`
ログを収集し、AIが日報を生成するためのデータを準備します。

### `save_summary`
生成された日報を長期ストレージに保存します。

### `get_history`
振り返りのために過去の要約を取得します（デフォルト: 過去6ヶ月）。

### `configure`
`retention_days` や `default_template` などのサーバー設定を更新します。

### `get_config`
現在のサーバー設定を表示します。

---

## 仕組み

```
┌─────────────────────────────────────────────────────────────┐
│                        あなたの一日                          │
├─────────────────────────────────────────────────────────────┤
│  9:00  「PR #123をレビュー」        → log(work, ...)        │
│ 11:00  「Kyselyの採用を決定」       → log(decision, ...)    │
│ 15:00  「デプロイを承認」           → log(approval, ...)    │
│ 18:00  「今日の日報を作成」         → prepare_report()      │
│         AIが日報を作成              → save_summary()        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    ~/.remem/remem.db                        │
├─────────────────────────────────────────────────────────────┤
│  activities（30日後に期限切れ）                              │
│  daily_summaries（永続保存）                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      6ヶ月後                                 │
├─────────────────────────────────────────────────────────────┤
│  「前四半期に何をやったっけ？」                              │
│  → get_history(months: 6)                                   │
│  → AIがあなたの成長と成果をまとめる                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 設定

| キー | デフォルト | 説明 |
|------|-----------|------|
| `retention_days` | `30` | 詳細なアクティビティログの保持日数 |
| `default_template` | （組み込み） | 日報のMarkdownテンプレート |

`configure` ツールまたは `~/.remem/remem.db` を直接編集して設定できます。

---

## 開発

```bash
# リポジトリをクローン
git clone https://github.com/remem-mcp/remem.git
cd remem

# 依存関係をインストール
npm install

# ビルド
npm run build

# テスト実行
npm test

# ローカルで実行
node build/index.js
```

### 技術スタック

- **ランタイム**: Node.js 24+
- **言語**: TypeScript
- **データベース**: SQLite（Kysely + better-sqlite3）
- **プロトコル**: MCP SDK
- **国際化**: i18next
- **テスト**: Vitest

---

## ロードマップ

- [ ] 履歴閲覧用のWeb UI
- [ ] Markdown/PDFエクスポート
- [ ] クラウドストレージ経由のチーム同期
- [ ] 多言語対応の拡充（中国語、韓国語、スペイン語など）
- [ ] VS Code拡張機能との統合

---

## コントリビュート

コントリビュートは大歓迎です！お気軽にPull Requestを送ってください。

1. リポジトリをフォーク
2. フィーチャーブランチを作成（`git checkout -b feature/amazing-feature`）
3. [Conventional Commits](https://www.conventionalcommits.org/ja/) 形式でコミット
4. ブランチにプッシュ（`git push origin feature/amazing-feature`）
5. Pull Requestを作成

### コミットメッセージの形式

このプロジェクトでは [Conventional Commits](https://www.conventionalcommits.org/ja/) を採用しています。

```
<type>: <description>

[任意の本文]
```

**Type:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

**例:**
```
feat: add weekly summary generation
fix: correct date parsing in prepare_report
docs: update installation instructions
```

---

## ライセンス

MIT © [Remem Contributors](https://github.com/remem-mcp)

---

<div align="center">

**[⬆ トップに戻る](#remem)**

</div>
