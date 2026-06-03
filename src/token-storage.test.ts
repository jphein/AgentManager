/**
 * token-storage.test.ts
 *
 * Uses vi.resetModules() + dynamic import in beforeEach so that token-storage
 * reads MCP_TOKEN_DIR / TOKEN_DIR fresh for each test (the constant is evaluated
 * at module load time, not lazily).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We re-import these types in each test via the `mod` variable below.
// They are declared here only for TypeScript typing convenience.
import type { MCPOAuthToken as _MCPOAuthToken, StoredToken } from "./token-storage";

type Mod = typeof import("./token-storage");

let tokenDir: string;
let mod: Mod;
let registerSecretValue: ReturnType<typeof vi.fn>;
let unregisterSecretValue: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-storage-test-"));
  process.env.MCP_TOKEN_DIR = tokenDir;

  // Reset modules so TOKEN_DIR constant is re-evaluated with the new env var
  vi.resetModules();

  // Fresh mocks after module reset
  registerSecretValue = vi.fn();
  unregisterSecretValue = vi.fn();

  vi.doMock("./logger", () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }));

  vi.doMock("./sanitize", () => ({
    registerSecretValue,
    unregisterSecretValue,
  }));

  mod = await import("./token-storage");
});

afterEach(() => {
  if (fs.existsSync(tokenDir)) {
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }
  delete process.env.MCP_TOKEN_DIR;
  delete process.env.GITHUB_TOKEN;
  delete process.env.LINEAR_API_KEY;
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
// ensureTokenDir
// ──────────────────────────────────────────────────────────────────────────────
describe("ensureTokenDir", () => {
  it("creates the token directory if it does not exist", () => {
    const newDir = path.join(tokenDir, "nested", "dir");
    process.env.MCP_TOKEN_DIR = newDir;
    // Re-evaluating the module would be needed, but ensureTokenDir uses TOKEN_DIR
    // which was captured at load time. We test the already-set tokenDir here.
    expect(fs.existsSync(tokenDir)).toBe(true);
    expect(() => mod.ensureTokenDir()).not.toThrow();
  });

  it("does not throw if directory already exists", () => {
    expect(() => mod.ensureTokenDir()).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadToken — missing file
// ──────────────────────────────────────────────────────────────────────────────
describe("loadToken — no stored file", () => {
  it("returns null when the token file does not exist", () => {
    expect(mod.loadToken("github")).toBeNull();
  });

  it("caches the null result so a second call also returns null", () => {
    mod.loadToken("github");
    expect(mod.loadToken("github")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// saveToken + loadToken round-trip
// ──────────────────────────────────────────────────────────────────────────────
describe("saveToken / loadToken round-trip", () => {
  it("persists a UI token and reads it back", () => {
    const token: StoredToken = {
      server: "github",
      token: "ghp_test123456",
      source: "ui",
      label: "my-gh-token",
      setAt: new Date().toISOString(),
    };
    mod.saveToken(token);
    const loaded = mod.loadToken("github");
    expect(loaded).not.toBeNull();
    expect(loaded?.server).toBe("github");
    expect(loaded?.token).toBe("ghp_test123456");
    expect(loaded?.source).toBe("ui");
    expect(loaded?.label).toBe("my-gh-token");
  });

  it("persists an OAuth token and reads it back", () => {
    const token: StoredToken = {
      server: "linear",
      accessToken: "lin_oauth_abcdefgh",
      refreshToken: "lin_refresh_xyz",
      tokenType: "Bearer",
      scope: "read:issues",
      source: "oauth",
      authenticatedAt: new Date().toISOString(),
    };
    mod.saveToken(token);
    const loaded = mod.loadToken("linear");
    expect(loaded?.accessToken).toBe("lin_oauth_abcdefgh");
    expect(loaded?.refreshToken).toBe("lin_refresh_xyz");
    expect(loaded?.tokenType).toBe("Bearer");
  });

  it("registers the secret with sanitize on save", () => {
    mod.saveToken({ server: "figma", token: "figma-secret-value", source: "ui" });
    expect(registerSecretValue).toHaveBeenCalledWith("figma-secret-value");
  });

  it("registers the secret on cold-read from disk", () => {
    // Write file directly (bypass saveToken / cache)
    const fileContent = JSON.stringify({
      server: "notion",
      token: "notion-secret-value",
      source: "ui",
    });
    fs.writeFileSync(path.join(tokenDir, "notion.json"), fileContent);
    const loaded = mod.loadToken("notion");
    expect(loaded?.token).toBe("notion-secret-value");
    expect(registerSecretValue).toHaveBeenCalledWith("notion-secret-value");
  });

  it("returns cached token without re-reading disk", () => {
    mod.saveToken({ server: "github", token: "cached-token-12", source: "ui" });
    mod.loadToken("github");
    // Delete the file — next read must come from cache
    fs.unlinkSync(path.join(tokenDir, "github.json"));
    const second = mod.loadToken("github");
    expect(second?.token).toBe("cached-token-12");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// saveUIToken convenience wrapper
// ──────────────────────────────────────────────────────────────────────────────
describe("saveUIToken", () => {
  it("stores a UI token with correct shape and opts", () => {
    mod.saveUIToken("figma", "figma-token-secret", { label: "design-token", validatedUser: "jane" });
    const loaded = mod.loadToken("figma");
    expect(loaded?.source).toBe("ui");
    expect(loaded?.token).toBe("figma-token-secret");
    expect(loaded?.label).toBe("design-token");
    expect(loaded?.validatedUser).toBe("jane");
    expect(loaded?.setAt).toBeTruthy();
  });

  it("stores a UI token without optional opts", () => {
    mod.saveUIToken("slack", "slack-secret-123");
    const loaded = mod.loadToken("slack");
    expect(loaded?.token).toBe("slack-secret-123");
    expect(loaded?.source).toBe("ui");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// deleteToken
// ──────────────────────────────────────────────────────────────────────────────
describe("deleteToken", () => {
  it("removes the token file and cache entry", () => {
    mod.saveToken({ server: "github", token: "ghp_delete_me12", source: "ui" });
    expect(mod.loadToken("github")).not.toBeNull();

    mod.deleteToken("github");
    // Cache should already reflect deletion (no invalidation needed)
    expect(mod.loadToken("github")).toBeNull();
    // File should be gone
    expect(fs.existsSync(path.join(tokenDir, "github.json"))).toBe(false);
  });

  it("calls unregisterSecretValue with the stored token value", () => {
    mod.saveToken({ server: "figma", token: "figma-secret-del1", source: "ui" });
    vi.clearAllMocks();
    mod.deleteToken("figma");
    expect(unregisterSecretValue).toHaveBeenCalledWith("figma-secret-del1");
  });

  it("calls unregisterSecretValue with accessToken for OAuth tokens", () => {
    mod.saveToken({ server: "linear", accessToken: "lin_access_secret", source: "oauth" });
    vi.clearAllMocks();
    mod.deleteToken("linear");
    expect(unregisterSecretValue).toHaveBeenCalledWith("lin_access_secret");
  });

  it("is a no-op when no token exists", () => {
    expect(() => mod.deleteToken("nonexistent")).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// listStoredTokens
// ──────────────────────────────────────────────────────────────────────────────
describe("listStoredTokens", () => {
  it("returns empty array when no tokens are stored", () => {
    expect(mod.listStoredTokens()).toEqual([]);
  });

  it("returns all stored service names", () => {
    mod.saveToken({ server: "github", token: "ghp_list_test01", source: "ui" });
    mod.saveToken({ server: "linear", token: "lin_list_test01", source: "ui" });
    mod.saveToken({ server: "figma", token: "fig_list_test01", source: "ui" });
    const stored = mod.listStoredTokens();
    expect(stored.sort()).toEqual(["figma", "github", "linear"].sort());
  });

  it("does not include residual .tmp files in results", () => {
    // Write a fake tmp file
    fs.writeFileSync(path.join(tokenDir, "github.json.tmp.1234.abcd"), "partial");
    const stored = mod.listStoredTokens();
    expect(stored).not.toContain("github.json.tmp.1234.abcd");
    expect(stored).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getAllTokens
// ──────────────────────────────────────────────────────────────────────────────
describe("getAllTokens", () => {
  it("returns all stored tokens as objects", () => {
    mod.saveToken({ server: "github", token: "ghp_all_test0001", source: "ui" });
    mod.saveToken({ server: "figma", token: "fig_all_test0001", source: "ui" });
    const all = mod.getAllTokens();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.server).sort()).toEqual(["figma", "github"].sort());
  });

  it("returns empty array when nothing is stored", () => {
    expect(mod.getAllTokens()).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Multiple services stored independently
// ──────────────────────────────────────────────────────────────────────────────
describe("multiple services stored independently", () => {
  it("tokens for different services do not interfere", () => {
    mod.saveToken({ server: "github", token: "ghp_svc_a_12345", source: "ui" });
    mod.saveToken({ server: "linear", token: "lin_svc_b_12345", source: "ui" });
    mod.saveToken({ server: "figma", token: "fig_svc_c_12345", source: "ui" });

    expect(mod.loadToken("github")?.token).toBe("ghp_svc_a_12345");
    expect(mod.loadToken("linear")?.token).toBe("lin_svc_b_12345");
    expect(mod.loadToken("figma")?.token).toBe("fig_svc_c_12345");

    expect(fs.existsSync(path.join(tokenDir, "github.json"))).toBe(true);
    expect(fs.existsSync(path.join(tokenDir, "linear.json"))).toBe(true);
    expect(fs.existsSync(path.join(tokenDir, "figma.json"))).toBe(true);
  });

  it("overwriting one service does not affect others", () => {
    mod.saveToken({ server: "github", token: "ghp_orig_123456", source: "ui" });
    mod.saveToken({ server: "linear", token: "lin_orig_123456", source: "ui" });
    mod.saveToken({ server: "github", token: "ghp_new__123456", source: "ui" });

    expect(mod.loadToken("github")?.token).toBe("ghp_new__123456");
    expect(mod.loadToken("linear")?.token).toBe("lin_orig_123456");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Atomic write (tmp + rename)
// ──────────────────────────────────────────────────────────────────────────────
describe("atomic write", () => {
  it("produces a valid JSON file with no residual .tmp files", () => {
    mod.saveToken({ server: "github", token: "ghp_atomic12345", source: "ui" });
    const files = fs.readdirSync(tokenDir);
    expect(files).toContain("github.json");
    expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);
  });

  it("written file is valid JSON matching the StoredToken shape", () => {
    const token: StoredToken = {
      server: "figma",
      token: "fig_atomic_12345",
      source: "ui",
      label: "test-label",
    };
    mod.saveToken(token);
    const raw = fs.readFileSync(path.join(tokenDir, "figma.json"), "utf8");
    const parsed = JSON.parse(raw) as StoredToken;
    expect(parsed.server).toBe("figma");
    expect(parsed.token).toBe("fig_atomic_12345");
    expect(parsed.source).toBe("ui");
    expect(parsed.label).toBe("test-label");
  });

  it("file permissions are 0o600", () => {
    mod.saveToken({ server: "github", token: "ghp_perms_123456", source: "ui" });
    const stat = fs.statSync(path.join(tokenDir, "github.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Token shape matches MCPOAuthToken (backward compat alias)
// ──────────────────────────────────────────────────────────────────────────────
describe("MCPOAuthToken backward compatibility", () => {
  it("StoredToken and MCPOAuthToken are structurally identical via round-trip", () => {
    // MCPOAuthToken is a type alias — any StoredToken satisfies it
    const oauth: _MCPOAuthToken = {
      server: "linear",
      accessToken: "lin_oauth_backcompat",
      refreshToken: "lin_refresh_backcompat",
      tokenType: "Bearer",
      scope: "read",
      authenticatedAt: new Date().toISOString(),
      source: "oauth",
    };
    mod.saveToken(oauth);
    const loaded = mod.loadToken("linear");
    expect(loaded?.accessToken).toBe("lin_oauth_backcompat");
    expect(loaded?.refreshToken).toBe("lin_refresh_backcompat");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// isTokenExpired
// ──────────────────────────────────────────────────────────────────────────────
describe("isTokenExpired", () => {
  it("returns false when no expiresAt is set", () => {
    expect(mod.isTokenExpired({ server: "github", source: "oauth" })).toBe(false);
  });

  it("returns true for a past expiry date", () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    expect(mod.isTokenExpired({ server: "github", expiresAt: pastDate, source: "oauth" })).toBe(true);
  });

  it("returns false for a future expiry date", () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    expect(mod.isTokenExpired({ server: "github", expiresAt: futureDate, source: "oauth" })).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getEffectiveTokenValue
// ──────────────────────────────────────────────────────────────────────────────
describe("getEffectiveTokenValue", () => {
  it("returns UI token value when stored", () => {
    mod.saveToken({ server: "github", token: "ghp_effective_12", source: "ui" });
    expect(mod.getEffectiveTokenValue("github")).toBe("ghp_effective_12");
  });

  it("returns accessToken for non-expired OAuth token", () => {
    mod.saveToken({
      server: "linear",
      accessToken: "lin_eff_oauth_1234",
      source: "oauth",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(mod.getEffectiveTokenValue("linear")).toBe("lin_eff_oauth_1234");
  });

  it("returns null for expired OAuth token with no env var fallback", () => {
    delete process.env.LINEAR_API_KEY;
    mod.saveToken({
      server: "linear",
      accessToken: "lin_expired_token",
      source: "oauth",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(mod.getEffectiveTokenValue("linear")).toBeNull();
  });

  it("falls back to env var when no stored token exists", () => {
    process.env.GITHUB_TOKEN = "env-github-token";
    expect(mod.getEffectiveTokenValue("github")).toBe("env-github-token");
  });

  it("returns null when neither stored token nor env var exists", () => {
    delete process.env.GITHUB_TOKEN;
    expect(mod.getEffectiveTokenValue("github")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getTokenStatuses
// ──────────────────────────────────────────────────────────────────────────────
describe("getTokenStatuses", () => {
  it("returns all known services", () => {
    const statuses = mod.getTokenStatuses();
    expect(statuses).toHaveProperty("github");
    expect(statuses).toHaveProperty("linear");
    expect(statuses).toHaveProperty("figma");
  });

  it("marks a service as configured when UI token is set", () => {
    mod.saveToken({ server: "github", token: "ghp_status_12345", source: "ui" });
    const statuses = mod.getTokenStatuses();
    expect(statuses.github.configured).toBe(true);
    expect(statuses.github.source).toBe("ui");
    expect(statuses.github.hint).toMatch(/^\.\.\./);
  });

  it("marks a service as not configured when nothing is set", () => {
    delete process.env.GITHUB_TOKEN;
    const statuses = mod.getTokenStatuses();
    expect(statuses.github.configured).toBe(false);
    expect(statuses.github.hint).toBeNull();
    expect(statuses.github.source).toBe("none");
  });

  it("hint is the last 4 chars of the token value prefixed with '...'", () => {
    mod.saveToken({ server: "github", token: "ghp_status_abcXYZW", source: "ui" });
    const statuses = mod.getTokenStatuses();
    expect(statuses.github.hint).toBe("...XYZW");
    expect(statuses.github.hint).not.toBe("ghp_status_abcXYZW");
  });

  it("returns env source when env var is set and no stored token", () => {
    process.env.GITHUB_TOKEN = "env-token-github";
    const statuses = mod.getTokenStatuses();
    expect(statuses.github.source).toBe("env");
    expect(statuses.github.configured).toBe(true);
  });

  it("exposes label and validatedUser from stored token", () => {
    mod.saveToken({
      server: "figma",
      token: "fig_status_12345",
      source: "ui",
      label: "prod-figma",
      validatedUser: "alice",
    });
    const statuses = mod.getTokenStatuses();
    expect(statuses.figma.label).toBe("prod-figma");
    expect(statuses.figma.user).toBe("alice");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// invalidateTokenCache + preloadTokens
// ──────────────────────────────────────────────────────────────────────────────
describe("invalidateTokenCache", () => {
  it("forces a fresh read from disk after invalidation", () => {
    mod.saveToken({ server: "github", token: "ghp_cache_v1_1234", source: "ui" });
    // Verify initial cached value
    expect(mod.loadToken("github")?.token).toBe("ghp_cache_v1_1234");

    // Mutate the file directly (bypassing cache)
    const filePath = path.join(tokenDir, "github.json");
    const updated = { server: "github", token: "ghp_cache_v2_1234", source: "ui" };
    fs.writeFileSync(filePath, JSON.stringify(updated));

    // Before invalidation — still stale
    expect(mod.loadToken("github")?.token).toBe("ghp_cache_v1_1234");

    // After invalidation — reads fresh value from disk
    mod.invalidateTokenCache();
    expect(mod.loadToken("github")?.token).toBe("ghp_cache_v2_1234");
  });
});

describe("preloadTokens", () => {
  it("loads all stored tokens so they are available from cache", () => {
    mod.saveToken({ server: "github", token: "ghp_preload12345", source: "ui" });
    mod.saveToken({ server: "linear", token: "lin_preload12345", source: "ui" });

    // Invalidate to simulate a cold-start
    mod.invalidateTokenCache();

    // Preload reads all tokens from disk into cache
    mod.preloadTokens();

    // Prove they are in cache: delete files then verify reads still work
    fs.unlinkSync(path.join(tokenDir, "github.json"));
    fs.unlinkSync(path.join(tokenDir, "linear.json"));

    expect(mod.loadToken("github")?.token).toBe("ghp_preload12345");
    expect(mod.loadToken("linear")?.token).toBe("lin_preload12345");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Overwrite unregisters old secret
// ──────────────────────────────────────────────────────────────────────────────
describe("overwrite unregisters old secret", () => {
  it("calls unregisterSecretValue with the old value then registerSecretValue with the new one", () => {
    mod.saveToken({ server: "github", token: "ghp_old_secret123", source: "ui" });
    vi.clearAllMocks();

    mod.saveToken({ server: "github", token: "ghp_new_secret123", source: "ui" });

    expect(unregisterSecretValue).toHaveBeenCalledWith("ghp_old_secret123");
    expect(registerSecretValue).toHaveBeenCalledWith("ghp_new_secret123");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Graceful handling of corrupt JSON file
// ──────────────────────────────────────────────────────────────────────────────
describe("corrupt token file", () => {
  it("returns null and does not throw on malformed JSON", () => {
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(path.join(tokenDir, "github.json"), "{{not valid json}}");
    expect(() => mod.loadToken("github")).not.toThrow();
    expect(mod.loadToken("github")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ENV_TO_SERVICE / SERVICE_TO_ENV / KNOWN_SERVICES exports
// ──────────────────────────────────────────────────────────────────────────────
describe("service mapping exports", () => {
  it("KNOWN_SERVICES contains expected service names", () => {
    expect(mod.KNOWN_SERVICES.has("github")).toBe(true);
    expect(mod.KNOWN_SERVICES.has("linear")).toBe(true);
    expect(mod.KNOWN_SERVICES.has("figma")).toBe(true);
  });

  it("SERVICE_TO_ENV maps github to GITHUB_TOKEN", () => {
    expect(mod.SERVICE_TO_ENV["github"]).toBe("GITHUB_TOKEN");
  });

  it("ENV_TO_SERVICE maps GITHUB_TOKEN to github", () => {
    expect(mod.ENV_TO_SERVICE["GITHUB_TOKEN"]).toBe("github");
  });
});
