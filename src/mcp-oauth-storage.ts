import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mcpTokenDir } from "./bridge-paths";
import { logger } from "./logger";
import { errorMessage } from "./types";

export interface MCPOAuthToken {
  server: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType: string;
  scope?: string;
  authenticatedAt: string;
}

/** Directory where MCP OAuth tokens are persisted (read at runtime so tests can override). */
function getMcpTokenDir(): string {
  return process.env.MCP_TOKEN_DIR || mcpTokenDir(); // guildmaster#14: was /persistent/mcp-tokens
}

/**
 * Ensures the MCP token directory exists
 */
export function ensureTokenDir(): void {
  const dir = getMcpTokenDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // tokens: owner only
    logger.info(`[MCP-OAuth] Created token directory: ${dir}`);
  }
}

/**
 * Get the file path for a server's token storage
 */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function getTokenFilePath(server: string): string {
  // A server name can never climb out of the token dir (e.g. "../shared-context/x", a
  // sibling under BRIDGE_HOME since guildmaster#14). Rejected, not stripped: stripping
  // would alias distinct names ("git.hub" → "github") onto one credential file.
  if (!SERVER_NAME.test(server)) {
    throw new Error(`[MCP-OAuth] invalid server name: ${JSON.stringify(server)}`);
  }
  return path.join(getMcpTokenDir(), `${server}.json`);
}

/**
 * Save OAuth token for a specific MCP server
 */
export function saveToken(token: MCPOAuthToken): void {
  ensureTokenDir();
  const filePath = getTokenFilePath(token.server);
  // A fresh 0600 file renamed over the target: an older 0644 file is replaced, never written
  // into while still readable (writeFileSync's mode applies only on create).
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    fs.rmSync(tmpPath, { force: true }); // a failed save must not leave the credential behind
    throw err;
  }
  logger.info(`[MCP-OAuth] Saved token for ${token.server}`);
}

/**
 * Load OAuth token for a specific MCP server
 * Returns null if token doesn't exist
 */
export function loadToken(server: string): MCPOAuthToken | null {
  const filePath = getTokenFilePath(server);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(filePath, "utf8");
    const token = JSON.parse(data) as MCPOAuthToken;
    return token;
  } catch (err: unknown) {
    logger.error(`[MCP-OAuth] Failed to load token for ${server}`, {
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Delete OAuth token for a specific MCP server
 */
export function deleteToken(server: string): void {
  const filePath = getTokenFilePath(server);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info(`[MCP-OAuth] Deleted token for ${server}`);
  }
}

/** Buffer (ms) before nominal expiry to consider token expired. Avoids using a token that expires mid-request. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/**
 * Check if a token is expired (or within buffer of expiry).
 */
export function isTokenExpired(token: MCPOAuthToken): boolean {
  if (!token.expiresAt) {
    return false; // No expiry means token doesn't expire
  }

  const expiresAt = new Date(token.expiresAt).getTime();
  const now = Date.now();
  return now >= expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * List all servers with stored tokens
 */
function listStoredTokens(): string[] {
  ensureTokenDir();
  try {
    const files = fs.readdirSync(getMcpTokenDir());
    // Names the validator would refuse (legacy "_x.json", ".old.json") are skipped, not fatal
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((n) => SERVER_NAME.test(n));
  } catch (err: unknown) {
    logger.error("[MCP-OAuth] Failed to list stored tokens", {
      error: errorMessage(err),
    });
    return [];
  }
}

/**
 * Get all stored tokens with their metadata
 */
export function getAllTokens(): MCPOAuthToken[] {
  const servers = listStoredTokens();
  return servers.map((server) => loadToken(server)).filter((token): token is MCPOAuthToken => token !== null);
}
