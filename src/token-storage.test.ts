import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./service-mapping.json", () => ({
  default: {
    envToService: { GITHUB_TOKEN: "github", LINEAR_API_KEY: "linear" },
    serviceToEnv: { github: "GITHUB_TOKEN", linear: "LINEAR_API_KEY" },
  },
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "ts-test-"));
  process.env.MCP_TOKEN_DIR = tmpDir;
});
afterEach(() => {
  delete process.env.MCP_TOKEN_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("token-storage constants", async () => {
  it("KNOWN_SERVICES contains mapped services", async () => {
    const { KNOWN_SERVICES, ENV_TO_SERVICE, SERVICE_TO_ENV } = await import("./token-storage");
    expect(KNOWN_SERVICES.size).toBeGreaterThan(0);
    expect(typeof ENV_TO_SERVICE).toBe("object");
    expect(typeof SERVICE_TO_ENV).toBe("object");
  });
});

describe("saveToken / loadToken / deleteToken", async () => {
  it("saves and loads a token by server", async () => {
    const { saveToken, loadToken } = await import("./token-storage");
    const token = { server: "github.com", token: "ghp_abc123", service: "github", createdAt: "2026-01-01T00:00:00Z" };
    saveToken(token);
    const loaded = loadToken("github.com");
    expect(loaded?.token).toBe("ghp_abc123");
    expect(loaded?.service).toBe("github");
  });

  it("returns null for unknown server", async () => {
    const { loadToken } = await import("./token-storage");
    expect(loadToken("nonexistent.example.com")).toBeNull();
  });

  it("deletes a token", async () => {
    const { saveToken, loadToken, deleteToken } = await import("./token-storage");
    saveToken({ server: "linear.app", token: "lin_api_xyz", service: "linear", createdAt: "2026-01-01T00:00:00Z" });
    deleteToken("linear.app");
    expect(loadToken("linear.app")).toBeNull();
  });

  it("overwrite: saving same server replaces the token", async () => {
    const { saveToken, loadToken } = await import("./token-storage");
    saveToken({ server: "github.com", token: "old", service: "github", createdAt: "2026-01-01T00:00:00Z" });
    saveToken({ server: "github.com", token: "new", service: "github", createdAt: "2026-01-01T00:00:00Z" });
    expect(loadToken("github.com")?.token).toBe("new");
  });

  it("deleteToken is a no-op for missing server", async () => {
    const { deleteToken } = await import("./token-storage");
    expect(() => deleteToken("ghost.example.com")).not.toThrow();
  });
});
