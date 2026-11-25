/**
 * `remem setup`: registers Remem with the MCP clients found on this computer,
 * so nobody has to edit configuration files by hand.
 *
 * Client configuration belongs to the user, so this code is careful: it never
 * replaces an existing "remem" entry, keeps every other setting, writes a
 * backup before changing a file, and refuses to touch a file it cannot parse.
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

export const SERVER_NAME = "remem";
export const SERVER_COMMAND = "npx";
export const SERVER_ARGS = ["-y", "@remem/mcp-server"];

/** Text that identifies a hook installed by Remem */
const HOOK_MARKER = "@remem/mcp-server";

export const SETUP_CLIENTS = ["claude-code", "claude-desktop", "codex"] as const;
export type SetupClient = (typeof SETUP_CLIENTS)[number];

export type SetupStatus = "added" | "exists" | "not_found" | "failed" | "would_add";

export interface SetupResult {
  target: SetupClient | "claude-code-hooks";
  status: SetupStatus;
  /** File that was (or would be) changed, or the reason for a failure */
  detail?: string;
}

export interface CommandResult {
  /** Exit code; null when the program is not installed */
  code: number | null;
  output: string;
}

export interface SetupEnvironment {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Run a program without a shell */
  run: (command: string, args: string[]) => Promise<CommandResult>;
}

export interface SetupOptions {
  clients?: readonly SetupClient[];
  /** Also install Claude Code hooks (daily briefing at session start, commit import at session end) */
  hooks?: boolean;
  /** Report what would change without changing anything */
  dryRun?: boolean;
}

/** The real environment of this process */
export function defaultEnvironment(): SetupEnvironment {
  return {
    home: os.homedir(),
    platform: process.platform,
    env: process.env,
    run: (command, args) =>
      new Promise((resolve) => {
        // On Windows, CLIs installed through npm are .cmd files and need a shell; the arguments here are fixed strings
        execFile(command, args, { shell: process.platform === "win32", timeout: 30_000 }, (error, stdout, stderr) => {
          const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
          const code = missing ? null : error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, output: `${stdout}${stderr}` });
        });
      }),
  };
}

/** Read a JSON object from a file; an absent file is an empty object, a broken file is an error */
function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Write a file, keeping a copy of the previous version next to it */
function writeWithBackup(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.remem-backup`);
  writeFileSync(path, content, "utf8");
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Register through a client's own `mcp` command (Claude Code and Codex work the same way) */
async function registerWithCli(
  target: SetupClient,
  program: string,
  addArgs: string[],
  environment: SetupEnvironment,
  dryRun: boolean
): Promise<SetupResult | null> {
  const probe = await environment.run(program, ["--version"]);
  if (probe.code === null) return null; // program not installed

  const current = await environment.run(program, ["mcp", "get", SERVER_NAME]);
  if (current.code === 0) return { target, status: "exists" };
  if (dryRun) return { target, status: "would_add", detail: `${program} ${addArgs.join(" ")}` };

  const added = await environment.run(program, addArgs);
  if (added.code === 0) return { target, status: "added" };
  if (/already exists/i.test(added.output)) return { target, status: "exists" };
  return { target, status: "failed", detail: added.output.trim().split("\n")[0] || `exit code ${added.code}` };
}

async function setupClaudeCode(environment: SetupEnvironment, dryRun: boolean): Promise<SetupResult> {
  const args = ["mcp", "add", "--transport", "stdio", "--scope", "user", SERVER_NAME, "--", SERVER_COMMAND, ...SERVER_ARGS];
  return (await registerWithCli("claude-code", "claude", args, environment, dryRun)) ?? { target: "claude-code", status: "not_found" };
}

/** Path of the Claude Desktop configuration file on this platform */
export function claudeDesktopConfigPath(environment: SetupEnvironment): string {
  const { home, platform, env } = environment;
  const directory =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : platform === "win32"
        ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
        : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude");
  return join(directory, "claude_desktop_config.json");
}

function setupClaudeDesktop(environment: SetupEnvironment, dryRun: boolean): SetupResult {
  const target = "claude-desktop" as const;
  const path = claudeDesktopConfigPath(environment);
  // The folder exists once the app has been started; without it the app is not installed
  if (!existsSync(dirname(path))) return { target, status: "not_found" };

  try {
    const config = readJsonObject(path);
    const servers = asRecord(config.mcpServers);
    if (SERVER_NAME in servers) return { target, status: "exists", detail: path };
    if (dryRun) return { target, status: "would_add", detail: path };

    config.mcpServers = { ...servers, [SERVER_NAME]: { command: SERVER_COMMAND, args: SERVER_ARGS } };
    writeWithBackup(path, `${JSON.stringify(config, null, 2)}\n`);
    return { target, status: "added", detail: path };
  } catch (error) {
    return { target, status: "failed", detail: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function setupCodex(environment: SetupEnvironment, dryRun: boolean): Promise<SetupResult> {
  const target = "codex" as const;
  const viaCli = await registerWithCli(target, "codex", ["mcp", "add", SERVER_NAME, "--", SERVER_COMMAND, ...SERVER_ARGS], environment, dryRun);
  if (viaCli) return viaCli;

  // Without the CLI on the PATH (e.g. IDE extension only), add the table to the shared config file
  const path = join(environment.env.CODEX_HOME ?? join(environment.home, ".codex"), "config.toml");
  if (!existsSync(dirname(path))) return { target, status: "not_found" };
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (/^\s*\[mcp_servers\.remem\]/m.test(current)) return { target, status: "exists", detail: path };
    if (dryRun) return { target, status: "would_add", detail: path };

    const table = `[mcp_servers.${SERVER_NAME}]\ncommand = "${SERVER_COMMAND}"\nargs = [${SERVER_ARGS.map((arg) => `"${arg}"`).join(", ")}]\n`;
    writeWithBackup(path, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${current === "" ? "" : "\n"}${table}`);
    return { target, status: "added", detail: path };
  } catch (error) {
    return { target, status: "failed", detail: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Hooks added to Claude Code's user settings */
export const CLAUDE_CODE_HOOKS = {
  // Text printed at session start is given to Claude, so the day's plan is known from the first message
  SessionStart: {
    matcher: "startup",
    hooks: [{ type: "command", command: `${SERVER_COMMAND} ${SERVER_ARGS.join(" ")} briefing`, timeout: 30 }],
  },
  // Session end hooks are cut off after 1.5 seconds unless a longer timeout is set
  SessionEnd: {
    hooks: [
      {
        type: "command",
        command: `${SERVER_COMMAND} ${SERVER_ARGS.join(" ")} import-commits --quiet --repo "\${CLAUDE_PROJECT_DIR:-.}"`,
        timeout: 60,
      },
    ],
  },
} as const;

function setupClaudeCodeHooks(environment: SetupEnvironment, dryRun: boolean): SetupResult {
  const target = "claude-code-hooks" as const;
  const directory = environment.env.CLAUDE_CONFIG_DIR ?? join(environment.home, ".claude");
  const path = join(directory, "settings.json");
  if (!existsSync(directory)) return { target, status: "not_found" };

  try {
    const settings = readJsonObject(path);
    const hooks = asRecord(settings.hooks);
    let changed = false;

    for (const [event, group] of Object.entries(CLAUDE_CODE_HOOKS)) {
      const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
      if (JSON.stringify(groups).includes(HOOK_MARKER)) continue; // already installed
      groups.push(group);
      hooks[event] = groups;
      changed = true;
    }

    if (!changed) return { target, status: "exists", detail: path };
    if (dryRun) return { target, status: "would_add", detail: path };
    settings.hooks = hooks;
    writeWithBackup(path, `${JSON.stringify(settings, null, 2)}\n`);
    return { target, status: "added", detail: path };
  } catch (error) {
    return { target, status: "failed", detail: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Register Remem with every requested client that is installed */
export async function runSetup(options: SetupOptions = {}, environment: SetupEnvironment = defaultEnvironment()): Promise<SetupResult[]> {
  const clients = options.clients ?? SETUP_CLIENTS;
  const dryRun = options.dryRun ?? false;
  const results: SetupResult[] = [];

  if (clients.includes("claude-code")) {
    const result = await setupClaudeCode(environment, dryRun);
    results.push(result);
    if (options.hooks) {
      results.push(
        result.status === "not_found" ? { target: "claude-code-hooks", status: "not_found" } : setupClaudeCodeHooks(environment, dryRun)
      );
    }
  }
  if (clients.includes("claude-desktop")) results.push(setupClaudeDesktop(environment, dryRun));
  if (clients.includes("codex")) results.push(await setupCodex(environment, dryRun));

  return results;
}
