#!/usr/bin/env node
/**
 * Remem - MCP Server for Daily Activity Logging & Reporting
 *
 * A local MCP server that captures daily activities, generates reports,
 * and preserves summaries for long-term reflection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import pkg from "../package.json" with { type: "json" };
import { RememDatabase } from "./database.js";
import { initI18n } from "./i18n.js";
import { registerTools } from "./tools.js";

/** Server metadata */
const SERVER_NAME = pkg.name;
const SERVER_VERSION = pkg.version;

/**
 * Initialize and start the MCP server
 */
async function main(): Promise<void> {
  // Initialize i18n
  const t = await initI18n();

  // Initialize database
  const db = new RememDatabase();
  await db.initialize();

  // Create MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all tools
  registerTools(server, db, t);

  // Setup graceful shutdown
  const cleanup = async (): Promise<void> => {
    await db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Start the server
main().catch((error) => {
  console.error("Failed to start Remem server:", error);
  process.exit(1);
});