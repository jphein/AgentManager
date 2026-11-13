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

  it("mcp-oauth-storage keeps tokens owner-only (dir 0700, file 0600, even over an old 0644 file)", async () => {
    const { saveToken } = await import("./mcp-oauth-storage");
    const dir = path.join(home, "mcp-tokens");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "github.json"), "{}", { mode: 0o644 });
    saveToken({ server: "github", accessToken: "x", tokenType: "Bearer", authenticatedAt: new Date().toISOString() });
    expect(fs.statSync(path.join(dir, "github.json")).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true });
    saveToken({ server: "linear", accessToken: "y", tokenType: "Bearer", authenticatedAt: new Date().toISOString() });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("mcp-oauth-storage never writes outside the token dir for a crafted server name", async () => {
    const { saveToken, loadToken } = await import("./mcp-oauth-storage");
    fs.mkdirSync(path.join(home, "shared-context"));
    saveToken({
      server: "../shared-context/leak",
      accessToken: "z",
      tokenType: "Bearer",
      authenticatedAt: new Date().toISOString(),
    });
    expect(fs.readdirSync(path.join(home, "shared-context"))).toEqual([]);
    expect(loadToken("../shared-context/leak")?.accessToken).toBe("z"); // same sanitised name round-trips
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
