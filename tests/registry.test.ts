import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * server.json is what the MCP Registry lists. The registry rejects a server
 * whose name does not match `mcpName` in the npm package, so a mismatch would
 * only show up as a failed release.
 */
describe("MCP Registry metadata (server.json)", () => {
  const server = read("server.json");
  const pkg = read("package.json");
  const [npmPackage] = server.packages as { registryType: string; identifier: string; version: string; transport: { type: string } }[];

  it("uses the name declared in package.json", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toMatch(/^io\.github\.remem-mcp\//);
  });

  it("points to the npm package, run over stdio", () => {
    expect(npmPackage).toMatchObject({ registryType: "npm", identifier: pkg.name, transport: { type: "stdio" } });
    expect((server.repository as { url: string }).url).toBe((pkg.repository as { url: string }).url);
  });

  it("keeps the description within the registry's 100 character limit", () => {
    expect((server.description as string).length).toBeGreaterThan(0);
    expect((server.description as string).length).toBeLessThanOrEqual(100);
  });

  it("carries the same version as package.json", () => {
    // The release workflow also sets both fields from package.json, so this guards the committed file
    expect(server.version).toBe(pkg.version);
    expect(npmPackage.version).toBe(pkg.version);
  });
});
