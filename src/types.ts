/**
 * Type definitions for Remem MCP Server
 */

/** Activity types that can be logged */
export type ActivityType = "work" | "decision" | "memo" | "approval";

/** Configuration keys stored in the database */
export type ConfigKey = "retention_days" | "default_template";

/** Activity record from the database */
export interface Activity {
  id: number;
  ts: string;
  type: ActivityType;
  content: string;
}

/** Daily summary record */
export interface DailySummary {
  date: string;
  summary: string;
}

/** Configuration value wrapper */
export interface ConfigValue {
  value: string;
}

/** Supported languages */
export type SupportedLanguage = "ja" | "en";

/** Localized message keys */
export interface Messages {
  logSuccess: (type: ActivityType) => string;
  summarySaved: string;
  configUpdated: (key: ConfigKey, value: string) => string;
  noLogsFound: string;
}
