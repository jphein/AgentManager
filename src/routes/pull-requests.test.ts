/**
 * Tests for src/routes/pull-requests.ts
 *
 * Pattern (matches existing route tests in this repo):
 *  1. Pure-function unit tests — logic extracted inline, no I/O.
 *  2. Integration tests — single shared express server, mocks configured via
 *     module-level imports. All integration calls use ?refresh=true to bypass
 *     the 30-second cache, except for explicit cache-behaviour tests.
 *
 * Key mock notes:
 *  - node:child_process uses a plain factory ({ execFile: vi.fn() }) so that
 *    promisify(execFile) uses the standard callback convention rather than
 *    execFile[util.promisify.custom], which would bypass the mock.
 *  - node:fs uses a plain factory for the same reason (existsSync etc. have
 *    no custom promisify, but the factory form ensures correct auto-mock).
 */

import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// Factory form for node:child_process avoids util.promisify.custom bypass.
// Factory form for node:fs avoids async-importOriginal incompatibility.
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

// Use importOriginal so the full fs module is present (path.join etc work),
// but our four intercepted functions are vi.fn() instances shared between
// the module's default export and named exports.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = vi.fn();
  const readdirSync = vi.fn();
  const statSync = vi.fn();
  const readFileSync = vi.fn();
  const patched = { ...actual, existsSync, readdirSync, statSync, readFileSync };
  return { ...patched, default: patched };
});

vi.mock("../secrets-store", () => ({ getRepoPat: vi.fn().mockReturnValue(undefined) }));
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Static imports (vitest hoists vi.mock calls above these)
// ---------------------------------------------------------------------------

import * as cpMod from "node:child_process";
import * as fsMod from "node:fs";
import * as secretsMod from "../secrets-store";
import { createPullRequestsRouter } from "./pull-requests";

// ---------------------------------------------------------------------------
// Pure-function extractions (inline copy from route — no router needed)
// ---------------------------------------------------------------------------

function deriveChecksStatus(
  rollup: Array<{ status?: string; conclusion?: string; state?: string }> | null,
): "pending" | "passing" | "failing" | "none" {
  if (!rollup || rollup.length === 0) return "none";
  const statuses = rollup.map((r) => (r.conclusion ?? r.state ?? r.status ?? "").toUpperCase());
  if (statuses.some((s) => s === "FAILURE" || s === "FAILED" || s === "ERROR")) return "failing";
  if (statuses.some((s) => s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED" || s === "EXPECTED"))
    return "pending";
  if (statuses.every((s) => ["SUCCESS", "COMPLETED", "SKIPPED", "NEUTRAL", ""].includes(s))) return "passing";
  return "pending";
}

function extractRepoSlug(remoteUrl: string): string | null {
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = remoteUrl.match(/github\.com:([^/]+\/[^/.]+)(\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return null;
}

function extractTokenFromUrl(remoteUrl: string): string | null {
  const match = remoteUrl.match(/https?:\/\/(?:[^:]+:)?([^@]+)@github\.com/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Shared test server
// ---------------------------------------------------------------------------

type AgentStub = { id: string; name: string; gitBranch?: string };

function makeAgentManager(agents: AgentStub[]) {
  return { list: () => agents } as unknown as import("../agents").AgentManager;
}

let activeAgentManager = makeAgentManager([]);

let server: http.Server;
let baseUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        createPullRequestsRouter(activeAgentManager)(req, res, next);
      });
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  activeAgentManager = makeAgentManager([]);
});

// HTTP GET helper — always uses ?refresh=true to bypass the 30s cache
function get(extraQs = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${baseUrl}/api/pull-requests?refresh=true${extraQs}`;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: "GET" },
      (res) => {
        let raw = "";
        res.on("data", (c: string) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// HTTP GET with explicit URL (for cache tests that need to control ?refresh)
function rawGet(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${baseUrl}${path}`;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: "GET" },
      (res) => {
        let raw = "";
        res.on("data", (c: string) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Sample GhPR fixture
const sampleGhPR = {
  number: 42,
  title: "feat: add something",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feature-branch",
  baseRefName: "main",
  isDraft: false,
  state: "OPEN",
  author: { login: "dev", name: "Dev User" },
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
  reviewDecision: null,
  additions: 10,
  deletions: 3,
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
  labels: [{ name: "bug" }],
};

// Configure mocks for a single-repo scenario
function setupMocks(ghPRs: object[] = [sampleGhPR]) {
  vi.mocked(fsMod.existsSync).mockReturnValue(true);
  vi.mocked(fsMod.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fsMod.readdirSync>);
  vi.mocked(fsMod.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fsMod.statSync>);
  vi.mocked(fsMod.readFileSync).mockImplementation(() => {
    throw new Error("no file");
  });
  vi.mocked(secretsMod.getRepoPat).mockReturnValue(undefined);

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (vi.mocked(cpMod.execFile) as any).mockImplementation(
    (_c: unknown, args: unknown, _o: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
      const a = args as string[];
      if (a.includes("remote")) {
        cb(null, { stdout: "https://github.com/org/myrepo.git\n" });
      } else if (a.includes("pr")) {
        cb(null, { stdout: JSON.stringify(ghPRs) });
      } else {
        cb(new Error("unexpected command"));
      }
      return {} as ReturnType<typeof cpMod.execFile>;
    },
  );
}

// ---------------------------------------------------------------------------
// Unit tests: deriveChecksStatus
// ---------------------------------------------------------------------------

describe("deriveChecksStatus", () => {
  it("returns none for null", () => expect(deriveChecksStatus(null)).toBe("none"));
  it("returns none for []", () => expect(deriveChecksStatus([])).toBe("none"));
  it("failing on FAILURE conclusion", () =>
    expect(deriveChecksStatus([{ conclusion: "FAILURE" }, { conclusion: "SUCCESS" }])).toBe("failing"));
  it("failing on FAILED state", () => expect(deriveChecksStatus([{ state: "FAILED" }])).toBe("failing"));
  it("failing on ERROR conclusion", () => expect(deriveChecksStatus([{ conclusion: "ERROR" }])).toBe("failing"));
  it("pending on PENDING status", () =>
    expect(deriveChecksStatus([{ status: "PENDING" }, { conclusion: "SUCCESS" }])).toBe("pending"));
  it("pending on IN_PROGRESS state", () => expect(deriveChecksStatus([{ state: "IN_PROGRESS" }])).toBe("pending"));
  it("passing when all SUCCESS", () =>
    expect(deriveChecksStatus([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }])).toBe("passing"));
  it("passing for SUCCESS/SKIPPED/NEUTRAL mix", () =>
    expect(deriveChecksStatus([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }])).toBe(
      "passing",
    ));
  it("passing for COMPLETED", () => expect(deriveChecksStatus([{ conclusion: "COMPLETED" }])).toBe("passing"));
  it("failing beats pending", () =>
    expect(deriveChecksStatus([{ conclusion: "FAILURE" }, { status: "PENDING" }])).toBe("failing"));
});

// ---------------------------------------------------------------------------
// Unit tests: extractRepoSlug
// ---------------------------------------------------------------------------

describe("extractRepoSlug", () => {
  it("HTTPS without token", () => expect(extractRepoSlug("https://github.com/org/repo.git")).toBe("org/repo"));
  it("HTTPS with embedded token", () =>
    expect(extractRepoSlug("https://x-access-token:ghp_abc@github.com/org/repo.git")).toBe("org/repo"));
  it("SSH", () => expect(extractRepoSlug("git@github.com:org/repo.git")).toBe("org/repo"));
  it("HTTPS without .git suffix", () => expect(extractRepoSlug("https://github.com/org/repo")).toBe("org/repo"));
  it("null for non-GitHub URL", () => expect(extractRepoSlug("https://gitlab.com/org/repo.git")).toBeNull());
  it("null for empty string", () => expect(extractRepoSlug("")).toBeNull());
});

// ---------------------------------------------------------------------------
// Unit tests: extractTokenFromUrl
// ---------------------------------------------------------------------------

describe("extractTokenFromUrl", () => {
  it("x-access-token style", () =>
    expect(extractTokenFromUrl("https://x-access-token:ghp_SECRET@github.com/org/repo")).toBe("ghp_SECRET"));
  it("bare token", () => expect(extractTokenFromUrl("https://ghp_TOKEN@github.com/org/repo")).toBe("ghp_TOKEN"));
  it("null when no token", () => expect(extractTokenFromUrl("https://github.com/org/repo")).toBeNull());
});

// ---------------------------------------------------------------------------
// Integration: empty / no repos
// ---------------------------------------------------------------------------

describe("GET /api/pull-requests — empty / no repos", () => {
  it("returns empty array when PERSISTENT_REPOS does not exist", async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(false);

    const res = await get();
    expect(res.status).toBe(200);
    const body = res.body as { pullRequests: unknown[]; fromCache: boolean };
    expect(body.pullRequests).toHaveLength(0);
    expect(body.fromCache).toBe(false);
  });

  it("returns empty array when git remote fails for all repos", async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsMod.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fsMod.readdirSync>);
    vi.mocked(fsMod.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fsMod.statSync>);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (vi.mocked(cpMod.execFile) as any).mockImplementation(
      (_c: unknown, _a: unknown, _o: unknown, cb: (e: Error | null) => void) => {
        cb(new Error("not a git repo"));
        return {} as ReturnType<typeof cpMod.execFile>;
      },
    );

    const res = await get();
    expect(res.status).toBe(200);
    expect((res.body as { pullRequests: unknown[] }).pullRequests).toHaveLength(0);
  });

  it("returns empty array when readdirSync throws", async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsMod.readdirSync).mockImplementation(() => {
      throw new Error("EPERM");
    });

    const res = await get();
    expect(res.status).toBe(200);
    expect((res.body as { pullRequests: unknown[] }).pullRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: PR shape
// ---------------------------------------------------------------------------

describe("GET /api/pull-requests — PR response shape", () => {
  beforeEach(() => setupMocks());

  it("returns a PR with all required fields", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const prs = (res.body as { pullRequests: Record<string, unknown>[] }).pullRequests;
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 42,
      title: "feat: add something",
      url: "https://github.com/org/repo/pull/42",
      state: "open",
      branch: "feature-branch",
      baseBranch: "main",
      author: "Dev User",
      repo: "myrepo",
      isDraft: false,
      additions: 10,
      deletions: 3,
      checksStatus: "passing",
      reviewDecision: "",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      agent: null,
      labels: ["bug"],
    });
  });

  it("state is draft when isDraft=true", async () => {
    setupMocks([{ ...sampleGhPR, isDraft: true }]);
    const res = await get();
    const prs = (res.body as { pullRequests: Record<string, unknown>[] }).pullRequests;
    expect(prs[0].state).toBe("draft");
    expect(prs[0].isDraft).toBe(true);
  });

  it("state is merged when gh state is MERGED", async () => {
    setupMocks([{ ...sampleGhPR, state: "MERGED", isDraft: false }]);
    const res = await get();
    expect((res.body as { pullRequests: Record<string, unknown>[] }).pullRequests[0].state).toBe("merged");
  });

  it("state is closed when gh state is CLOSED", async () => {
    setupMocks([{ ...sampleGhPR, state: "CLOSED", isDraft: false }]);
    const res = await get();
    expect((res.body as { pullRequests: Record<string, unknown>[] }).pullRequests[0].state).toBe("closed");
  });

  it("falls back to author login when author name is null", async () => {
    setupMocks([{ ...sampleGhPR, author: { login: "dev-login", name: null } }]);
    const res = await get();
    expect((res.body as { pullRequests: Record<string, unknown>[] }).pullRequests[0].author).toBe("dev-login");
  });

  it("returns empty labels array when labels is null", async () => {
    setupMocks([{ ...sampleGhPR, labels: null }]);
    const res = await get();
    expect((res.body as { pullRequests: Record<string, unknown>[] }).pullRequests[0].labels).toEqual([]);
  });

  it("returns 0 additions/deletions when fields are missing", async () => {
    const pr = { ...sampleGhPR } as Partial<typeof sampleGhPR>;
    delete pr.additions;
    delete pr.deletions;
    setupMocks([pr]);
    const res = await get();
    const p = (res.body as { pullRequests: Record<string, unknown>[] }).pullRequests[0];
    expect(p.additions).toBe(0);
    expect(p.deletions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: agent cross-referencing
// ---------------------------------------------------------------------------

describe("GET /api/pull-requests — agent cross-referencing", () => {
  beforeEach(() => setupMocks());

  it("attaches agent when gitBranch matches PR headRefName", async () => {
    activeAgentManager = makeAgentManager([{ id: "agent-1", name: "My Worker", gitBranch: "feature-branch" }]);
    const res = await get();
    const prs = (res.body as { pullRequests: Record<string, unknown>[] }).pullRequests;
    expect(prs[0].agent).toEqual({ id: "agent-1", name: "My Worker" });
  });

  it("sets agent to null when no branch matches", async () => {
    activeAgentManager = makeAgentManager([{ id: "agent-2", name: "Other Worker", gitBranch: "different-branch" }]);
    const res = await get();
    const prs = (res.body as { pullRequests: Record<string, unknown>[] }).pullRequests;
    expect(prs[0].agent).toBeNull();
  });

  it("sets agent to null when agent has no gitBranch property", async () => {
    activeAgentManager = makeAgentManager([{ id: "agent-3", name: "No Branch Agent" }]);
    const res = await get();
    const prs = (res.body as { pullRequests: Record<string, unknown>[] }).pullRequests;
    expect(prs[0].agent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: error handling
// ---------------------------------------------------------------------------

describe("GET /api/pull-requests — error handling", () => {
  it("returns empty array (not 500) when gh pr list exits with error", async () => {
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsMod.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fsMod.readdirSync>);
    vi.mocked(fsMod.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fsMod.statSync>);
    vi.mocked(fsMod.readFileSync).mockImplementation(() => {
      throw new Error("no file");
    });
    vi.mocked(secretsMod.getRepoPat).mockReturnValue(undefined);

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (vi.mocked(cpMod.execFile) as any).mockImplementation(
      (_c: unknown, args: unknown, _o: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
        const a = args as string[];
        if (a.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n" });
        } else {
          cb(new Error("gh: command not found"));
        }
        return {} as ReturnType<typeof cpMod.execFile>;
      },
    );

    const res = await get();
    expect(res.status).toBe(200);
    expect((res.body as { pullRequests: unknown[] }).pullRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: 30-second cache
// ---------------------------------------------------------------------------

describe("GET /api/pull-requests — 30-second cache", () => {
  it("returns fromCache:false on first call, fromCache:true on second (no refresh)", async () => {
    let ghCallCount = 0;
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsMod.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fsMod.readdirSync>);
    vi.mocked(fsMod.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fsMod.statSync>);
    vi.mocked(fsMod.readFileSync).mockImplementation(() => {
      throw new Error("no file");
    });
    vi.mocked(secretsMod.getRepoPat).mockReturnValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (vi.mocked(cpMod.execFile) as any).mockImplementation(
      (_c: unknown, args: unknown, _o: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
        const a = args as string[];
        if (a.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n" });
        } else if (a.includes("pr")) {
          ghCallCount++;
          cb(null, { stdout: JSON.stringify([sampleGhPR]) });
        } else {
          cb(new Error("unexpected"));
        }
        return {} as ReturnType<typeof cpMod.execFile>;
      },
    );

    // First: force-refresh to populate fresh cache
    const res1 = await rawGet("/api/pull-requests?refresh=true");
    expect(res1.status).toBe(200);
    expect(res1.body).toHaveProperty("fromCache", false);
    const ghAfterFirst = ghCallCount;

    // Second: no ?refresh — should hit cache
    const res2 = await rawGet("/api/pull-requests");
    expect(res2.status).toBe(200);
    expect(res2.body).toHaveProperty("fromCache", true);
    expect((res2.body as { pullRequests: unknown[] }).pullRequests).toHaveLength(1);
    expect(ghCallCount).toBe(ghAfterFirst);
  });

  it("bypasses cache when refresh=true is passed", async () => {
    let ghCallCount = 0;
    vi.mocked(fsMod.existsSync).mockReturnValue(true);
    vi.mocked(fsMod.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fsMod.readdirSync>);
    vi.mocked(fsMod.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fsMod.statSync>);
    vi.mocked(fsMod.readFileSync).mockImplementation(() => {
      throw new Error("no file");
    });
    vi.mocked(secretsMod.getRepoPat).mockReturnValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (vi.mocked(cpMod.execFile) as any).mockImplementation(
      (_c: unknown, args: unknown, _o: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
        const a = args as string[];
        if (a.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n" });
        } else if (a.includes("pr")) {
          ghCallCount++;
          cb(null, { stdout: JSON.stringify([sampleGhPR]) });
        } else {
          cb(new Error("unexpected"));
        }
        return {} as ReturnType<typeof cpMod.execFile>;
      },
    );

    await rawGet("/api/pull-requests?refresh=true");
    const afterFirst = ghCallCount;

    const res2 = await rawGet("/api/pull-requests?refresh=true");
    expect(res2.status).toBe(200);
    expect(res2.body).toHaveProperty("fromCache", false);
    expect(ghCallCount).toBeGreaterThan(afterFirst);
  });
});
