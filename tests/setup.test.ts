import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeDesktopConfigPath, runSetup, type CommandResult, type SetupEnvironment } from "../src/setup.js";

describe("remem setup", () => {
  let home: string;
  let calls: string[];

  /** A fake computer: which programs exist and whether "remem" is already registered with them */
  const environment = (programs: Record<string, { registered?: boolean; addFails?: string }> = {}): SetupEnvironment => ({
    home,
    platform: "linux",
    env: {},
    run: (command, args): Promise<CommandResult> => {
      calls.push([command, ...args].join(" "));
      const program = programs[command];
      if (!program) return Promise.resolve({ code: null, output: "" });
      if (args[0] === "--version") return Promise.resolve({ code: 0, output: "1.0.0" });
      if (args[1] === "get") return Promise.resolve({ code: program.registered ? 0 : 1, output: "" });
      if (args[1] === "add") {
        if (program.addFails) return Promise.resolve({ code: 1, output: program.addFails });
        program.registered = true;
        return Promise.resolve({ code: 0, output: "added" });
      }
      return Promise.resolve({ code: 1, output: "unexpected" });
    },
  });

  const readJson = (path: string): Record<string, never> => JSON.parse(readFileSync(path, "utf8")) as Record<string, never>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "remem-home-"));
    calls = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reports clients that are not installed and changes nothing", async () => {
    const results = await runSetup({ hooks: true }, environment());
    expect(results.map((r) => [r.target, r.status])).toEqual([
      ["claude-code", "not_found"],
      ["claude-code-hooks", "not_found"],
      ["claude-desktop", "not_found"],
      ["codex", "not_found"],
    ]);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("registers through the Claude Code and Codex command lines, once", async () => {
    const env = environment({ claude: {}, codex: {} });
    const first = await runSetup({ clients: ["claude-code", "codex"] }, env);
    expect(first.map((r) => r.status)).toEqual(["added", "added"]);
    expect(calls).toContain("claude mcp add --transport stdio --scope user remem -- npx -y @remem/mcp-server");
    expect(calls).toContain("codex mcp add remem -- npx -y @remem/mcp-server");

    calls = [];
    const second = await runSetup({ clients: ["claude-code", "codex"] }, env);
    expect(second.map((r) => r.status)).toEqual(["exists", "exists"]);
    expect(calls.some((call) => call.includes("mcp add"))).toBe(false);
  });

  it("treats 'already exists' as registered and reports other failures", async () => {
    const exists = await runSetup({ clients: ["claude-code"] }, environment({ claude: { addFails: "MCP server remem already exists in user config" } }));
    expect(exists[0].status).toBe("exists");

    const failed = await runSetup({ clients: ["claude-code"] }, environment({ claude: { addFails: "permission denied\nmore" } }));
    expect(failed[0]).toMatchObject({ status: "failed", detail: "permission denied" });
  });

  it("adds Remem to Claude Desktop without touching other settings", async () => {
    const env = environment();
    const path = claudeDesktopConfigPath(env);
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });
    writeFileSync(path, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "node", args: ["x.js"] } } }));

    const [result] = await runSetup({ clients: ["claude-desktop"] }, env);
    expect(result).toMatchObject({ status: "added", detail: path });
    expect(readJson(path)).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "node", args: ["x.js"] },
        remem: { command: "npx", args: ["-y", "@remem/mcp-server"] },
      },
    });
    // The previous version is kept
    expect(readJson(`${path}.remem-backup`)).toEqual({ theme: "dark", mcpServers: { other: { command: "node", args: ["x.js"] } } });

    expect((await runSetup({ clients: ["claude-desktop"] }, env))[0].status).toBe("exists");
  });

  it("creates the Claude Desktop config when the app has none yet, and refuses broken files", async () => {
    const env = environment();
    const path = claudeDesktopConfigPath(env);
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });

    expect((await runSetup({ clients: ["claude-desktop"] }, env))[0].status).toBe("added");
    expect(readJson(path)).toEqual({ mcpServers: { remem: { command: "npx", args: ["-y", "@remem/mcp-server"] } } });

    writeFileSync(path, "{ this is not json");
    const [broken] = await runSetup({ clients: ["claude-desktop"] }, env);
    expect(broken.status).toBe("failed");
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });

  it("knows the Claude Desktop config location on each platform", () => {
    const base = environment();
    expect(claudeDesktopConfigPath({ ...base, platform: "darwin" })).toBe(
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    );
    expect(claudeDesktopConfigPath({ ...base, platform: "win32", env: { APPDATA: join(home, "Roaming") } })).toBe(
      join(home, "Roaming", "Claude", "claude_desktop_config.json")
    );
  });

  it("adds a Codex config table when only the config folder exists", async () => {
    const path = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"));
    writeFileSync(path, 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "node"');

    const [result] = await runSetup({ clients: ["codex"] }, environment());
    expect(result.status).toBe("added");
    expect(readFileSync(path, "utf8")).toBe(
      'model = "gpt"\n\n[mcp_servers.other]\ncommand = "node"\n\n[mcp_servers.remem]\ncommand = "npx"\nargs = ["-y", "@remem/mcp-server"]\n'
    );
    expect((await runSetup({ clients: ["codex"] }, environment()))[0].status).toBe("exists");
  });

  it("installs Claude Code hooks next to existing ones, only once and only when asked", async () => {
    const path = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    const existing = { permissions: { allow: ["Bash(ls:*)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
    writeFileSync(path, JSON.stringify(existing));

    const without = await runSetup({ clients: ["claude-code"] }, environment({ claude: {} }));
    expect(without).toHaveLength(1);
    expect(readJson(path)).toEqual(existing);

    const results = await runSetup({ clients: ["claude-code"], hooks: true }, environment({ claude: { registered: true } }));
    expect(results.map((r) => [r.target, r.status])).toEqual([
      ["claude-code", "exists"],
      ["claude-code-hooks", "added"],
    ]);

    const settings = readJson(path) as unknown as {
      permissions: unknown;
      hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
    };
    expect(settings.permissions).toEqual(existing.permissions);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
    expect(settings.hooks.SessionStart[1]).toMatchObject({ matcher: "startup" });
    expect(settings.hooks.SessionStart[1].hooks[0].command).toBe("npx -y @remem/mcp-server briefing");
    // Session end hooks are cut off quickly unless a timeout is given
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(60);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain("import-commits --quiet");

    const again = await runSetup({ clients: ["claude-code"], hooks: true }, environment({ claude: { registered: true } }));
    expect(again[1].status).toBe("exists");
    expect((readJson(path) as unknown as typeof settings).hooks.SessionStart).toHaveLength(2);
  });

  it("changes nothing in a dry run", async () => {
    mkdirSync(join(home, ".config", "Claude"), { recursive: true });
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));

    const results = await runSetup({ hooks: true, dryRun: true }, environment({ claude: {} }));
    expect(results.map((r) => r.status)).toEqual(["would_add", "would_add", "would_add", "would_add"]);
    expect(calls.some((call) => call.includes("mcp add"))).toBe(false);
    expect(existsSync(claudeDesktopConfigPath(environment()))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });
});
