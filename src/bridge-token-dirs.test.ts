// guildmaster#14: with MCP_TOKEN_DIR unset, both token stores write under
// BRIDGE_HOME/mcp-tokens instead of the container-era /persistent/mcp-tokens
// (which gave a non-fatal startup EACCES on a local install).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("MCP token dirs default under BRIDGE_HOME (guildmaster#14)", () => {
  const OLD_BRIDGE = process.env.BRIDGE_HOME;
  const OLD_TOKEN = process.env.MCP_TOKEN_DIR;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gm-bridge-tokens-"));
    process.env.BRIDGE_HOME = home;
    delete process.env.MCP_TOKEN_DIR;
    vi.resetModules();
  });
  afterEach(() => {
    if (OLD_BRIDGE === undefined) delete process.env.BRIDGE_HOME;
    else process.env.BRIDGE_HOME = OLD_BRIDGE;
    if (OLD_TOKEN === undefined) delete process.env.MCP_TOKEN_DIR;
    else process.env.MCP_TOKEN_DIR = OLD_TOKEN;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("mcp-oauth-storage saves under BRIDGE_HOME/mcp-tokens", async () => {
    const { saveToken, loadToken } = await import("./mcp-oauth-storage");
    saveToken({ server: "github", accessToken: "x", tokenType: "Bearer", authenticatedAt: new Date().toISOString() });
    expect(fs.existsSync(path.join(home, "mcp-tokens"))).toBe(true);
    expect(fs.readdirSync(path.join(home, "mcp-tokens")).length).toBe(1);
    expect(loadToken("github")?.accessToken).toBe("x");
  });

  it("token-storage creates its dir under BRIDGE_HOME/mcp-tokens", async () => {
    const { ensureTokenDir } = await import("./token-storage");
    ensureTokenDir();
    expect(fs.existsSync(path.join(home, "mcp-tokens"))).toBe(true);
  });

  it("MCP_TOKEN_DIR still overrides", async () => {
    const custom = path.join(home, "custom-tokens");
    process.env.MCP_TOKEN_DIR = custom;
    const { ensureTokenDir } = await import("./token-storage");
    ensureTokenDir();
    expect(fs.existsSync(custom)).toBe(true);
    expect(fs.existsSync(path.join(home, "mcp-tokens"))).toBe(false);
  });
});
