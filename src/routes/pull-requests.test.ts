/**
 * Tests for the pull-requests route.
 *
 * Covers:
 * - GET /api/pull-requests returns 200 with PR list
 * - Cache behaviour (second call within 30s returns cached data)
 * - Cache bypass with ?refresh=true
 * - Error handling when fetchAllPRs throws
 * - getRepoPat from secrets-store is used for token resolution
 * - Response shape uses the AgentManager type (agent has id + name)
 */

import express, { type Express } from "express";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock the secrets-store so we never hit the filesystem
vi.mock("../secrets-store", () => ({
  getRepoPat: vi.fn().mockReturnValue(null),
}));

// Mock the logger to keep test output clean
vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock node:fs so we can control what repos "exist"
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  return {
    ...mocked,
    default: mocked,
  };
});

// Mock node:child_process to intercept gh CLI and git calls
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from "node:child_process";
// ---------------------------------------------------------------------------
// Imports after mocks are set up
// ---------------------------------------------------------------------------
import fs from "node:fs";
import type { AgentManager } from "../agents";
import { getRepoPat } from "../secrets-store";
import { createPullRequestsRouter } from "./pull-requests";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal AgentManager stub */
function makeAgentManager(agents: Array<{ id: string; name: string; gitBranch?: string }> = []): AgentManager {
  return {
    list: vi.fn().mockReturnValue(agents),
  } as unknown as AgentManager;
}

/** Wrap the router in a minimal Express app for supertest */
function makeApp(agentManager: AgentManager): Express {
  const app = express();
  app.use(express.json());
  app.use(createPullRequestsRouter(agentManager));
  return app;
}

/** Build a minimal GhPR JSON payload */
function makeGhPR(
  overrides: Partial<{
    number: number;
    title: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
    state: string;
    author: { login: string; name?: string | null };
    createdAt: string;
    updatedAt: string;
    reviewDecision: string | null;
    additions: number;
    deletions: number;
    statusCheckRollup: unknown[] | null;
    labels: Array<{ name: string }> | null;
  }> = {},
) {
  return {
    number: 42,
    title: "feat: add widgets",
    url: "https://github.com/org/myrepo/pull/42",
    headRefName: "feat/widgets",
    baseRefName: "main",
    isDraft: false,
    state: "OPEN",
    author: { login: "alice", name: "Alice" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    reviewDecision: null,
    additions: 10,
    deletions: 2,
    statusCheckRollup: null,
    labels: null,
    ...overrides,
  };
}

/**
 * Wire up fs mocks so that /persistent/repos contains a single repo
 * named `repoName` whose remote URL resolves to `repoSlug`.
 */
function setupFsMocks(repoName: string, remoteUrl: string) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readdirSync).mockReturnValue([repoName] as unknown as ReturnType<typeof fs.readdirSync>);
  vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

  // git remote get-url → remoteUrl
  vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
    const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
    const argsList = args as string[];
    if (argsList.includes("remote")) {
      cb(null, { stdout: remoteUrl + "\n", stderr: "" });
    } else {
      cb(null, { stdout: "[]", stderr: "" });
    }
    return {} as ReturnType<typeof execFile>;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/pull-requests", () => {
  beforeEach(() => {
    // Reset module-level cache between tests by re-importing through the
    // module boundary — we do this by resetting mocks and forcing a fresh
    // call path. The cache variable is module-private; we reset it indirectly
    // by always using ?refresh=true in tests that need a clean fetch, or by
    // relying on the fact that each describe block starts with fresh mocks.
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path — 200 with PR list
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("returns 200 with a pullRequests array", async () => {
      const ghPR = makeGhPR();
      setupFsMocks("myrepo.git", "https://github.com/org/myrepo.git");

      // Override execFile so gh pr list returns one PR
      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("pullRequests");
      expect(Array.isArray(res.body.pullRequests)).toBe(true);
      expect(res.body.pullRequests).toHaveLength(1);
    });

    it("maps GhPR fields to PullRequestItem shape correctly", async () => {
      const ghPR = makeGhPR({
        number: 7,
        title: "fix: typo",
        url: "https://github.com/org/myrepo/pull/7",
        headRefName: "fix/typo",
        baseRefName: "main",
        isDraft: false,
        state: "OPEN",
        author: { login: "bob", name: "Bob Smith" },
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-02T00:00:00Z",
        reviewDecision: "APPROVED",
        additions: 5,
        deletions: 1,
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        labels: [{ name: "bug" }],
      });

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      const pr = res.body.pullRequests[0];
      expect(pr.number).toBe(7);
      expect(pr.title).toBe("fix: typo");
      expect(pr.branch).toBe("fix/typo");
      expect(pr.baseBranch).toBe("main");
      expect(pr.author).toBe("Bob Smith");
      expect(pr.additions).toBe(5);
      expect(pr.deletions).toBe(1);
      expect(pr.checksStatus).toBe("passing");
      expect(pr.reviewDecision).toBe("APPROVED");
      expect(pr.labels).toEqual(["bug"]);
      expect(pr.isDraft).toBe(false);
      expect(pr.state).toBe("open");
      expect(pr.repo).toBe("myrepo"); // .git suffix stripped
    });

    it("sets state to draft when isDraft is true", async () => {
      const ghPR = makeGhPR({ isDraft: true, state: "OPEN" });

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      expect(res.body.pullRequests[0].state).toBe("draft");
    });

    it("returns empty pullRequests when /persistent/repos does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      expect(res.body.pullRequests).toEqual([]);
    });

    it("includes fromCache: false and cachedAt on a fresh fetch", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      expect(res.body.fromCache).toBe(false);
      expect(typeof res.body.cachedAt).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Cache behaviour
  // -------------------------------------------------------------------------
  describe("cache behaviour", () => {
    it("returns fromCache: true on a second call within 30 s", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      // Use a shared app instance so both requests share the same module cache
      const app = makeApp(makeAgentManager());

      // First call — seeds the cache
      const first = await supertest(app).get("/api/pull-requests?refresh=true");
      expect(first.body.fromCache).toBe(false);

      // Second call — should hit cache (no refresh param)
      const second = await supertest(app).get("/api/pull-requests");
      expect(second.status).toBe(200);
      expect(second.body.fromCache).toBe(true);
    });

    it("bypasses cache when ?refresh=true is passed", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const app = makeApp(makeAgentManager());

      // Seed the cache
      await supertest(app).get("/api/pull-requests?refresh=true");

      // Force refresh
      const res = await supertest(app).get("/api/pull-requests?refresh=true");
      expect(res.status).toBe(200);
      expect(res.body.fromCache).toBe(false);
    });

    it("returns the same cachedAt timestamp on a cached response", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const app = makeApp(makeAgentManager());

      const first = await supertest(app).get("/api/pull-requests?refresh=true");
      const second = await supertest(app).get("/api/pull-requests");

      expect(second.body.cachedAt).toBe(first.body.cachedAt);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("returns 500 when an unexpected error is thrown during fetch", async () => {
      // Make fs.existsSync throw an unexpected error to trigger the outer catch
      vi.mocked(fs.existsSync).mockImplementation(() => {
        throw new Error("disk read failure");
      });

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    });

    it("returns empty array (not 500) when a single repo gh call fails", async () => {
      // The route catches per-repo failures inside fetchPRsForRepo and returns []
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          // gh pr list fails
          cb(new Error("GitHub API unavailable"), { stdout: "", stderr: "error" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      // Should still return 200 with an empty list (failure is per-repo, not global)
      expect(res.status).toBe(200);
      expect(res.body.pullRequests).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. getRepoPat from secrets-store
  // -------------------------------------------------------------------------
  describe("getRepoPat integration", () => {
    it("calls getRepoPat with the stripped repo name", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: "[]", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      const app = makeApp(makeAgentManager());
      await supertest(app).get("/api/pull-requests?refresh=true");

      expect(getRepoPat).toHaveBeenCalledWith("myrepo");
    });

    it("passes the PAT returned by getRepoPat as GH_TOKEN to gh CLI", async () => {
      vi.mocked(getRepoPat).mockReturnValue("my-secret-pat");

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];

      vi.mocked(execFile).mockImplementation((_cmd, args, opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        const options = opts as { env?: NodeJS.ProcessEnv };
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          capturedEnvs.push(options?.env);
          cb(null, { stdout: "[]", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      const app = makeApp(makeAgentManager());
      await supertest(app).get("/api/pull-requests?refresh=true");

      expect(capturedEnvs.length).toBeGreaterThan(0);
      expect(capturedEnvs[0]).toBeDefined();
      expect(capturedEnvs[0]?.GH_TOKEN).toBe("my-secret-pat");
    });

    it("omits env override when getRepoPat returns null and no URL token", async () => {
      vi.mocked(getRepoPat).mockReturnValue(null);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      // No .repo-token file
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      // Temporarily remove ambient GH tokens from the environment so that
      // resolveGhToken() has no fallback and passes env:undefined to gh CLI.
      const savedGhToken = process.env.GH_TOKEN;
      const savedGithubToken = process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;

      const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];

      vi.mocked(execFile).mockImplementation((_cmd, args, opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        const options = opts as { env?: NodeJS.ProcessEnv };
        if (argsList.includes("remote")) {
          // URL with no embedded token
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          capturedEnvs.push(options?.env);
          cb(null, { stdout: "[]", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      try {
        const app = makeApp(makeAgentManager());
        await supertest(app).get("/api/pull-requests?refresh=true");

        // env should be undefined (no token available, so no env override passed)
        expect(capturedEnvs.length).toBeGreaterThan(0);
        expect(capturedEnvs[0]).toBeUndefined();
      } finally {
        // Restore environment
        if (savedGhToken !== undefined) process.env.GH_TOKEN = savedGhToken;
        if (savedGithubToken !== undefined) process.env.GITHUB_TOKEN = savedGithubToken;
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. AgentManager cross-reference (agent field uses id + name)
  // -------------------------------------------------------------------------
  describe("AgentManager cross-reference", () => {
    it("attaches the matching agent { id, name } when branch matches", async () => {
      const ghPR = makeGhPR({ headRefName: "feat/widgets" });

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      const agents = [{ id: "agent-abc", name: "Widget Agent", gitBranch: "feat/widgets" }];
      const app = makeApp(makeAgentManager(agents));
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      const pr = res.body.pullRequests[0];
      // agent field must use AgentManager shape: { id, name }
      expect(pr.agent).toEqual({ id: "agent-abc", name: "Widget Agent" });
    });

    it("sets agent to null when no agent branch matches the PR branch", async () => {
      const ghPR = makeGhPR({ headRefName: "feat/widgets" });

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      // Agent has a different branch
      const agents = [{ id: "agent-xyz", name: "Other Agent", gitBranch: "other/branch" }];
      const app = makeApp(makeAgentManager(agents));
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      expect(res.body.pullRequests[0].agent).toBeNull();
    });

    it("sets agent to null when agent has no gitBranch set", async () => {
      const ghPR = makeGhPR({ headRefName: "feat/widgets" });

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      // Agent has no gitBranch
      const agents = [{ id: "agent-abc", name: "Branchless Agent" }];
      const app = makeApp(makeAgentManager(agents));
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      expect(res.body.pullRequests[0].agent).toBeNull();
    });

    it("agent object uses the AgentManager id field, not a Fanbot userId", async () => {
      // Explicitly verify the response shape has exactly { id, name } — not any
      // Fanbot-specific field like userId, fanbot_id, etc.
      const ghPR = makeGhPR({ headRefName: "my-branch" });

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["myrepo.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      const agents = [{ id: "agentmgr-uuid-001", name: "My Agent", gitBranch: "my-branch" }];
      const app = makeApp(makeAgentManager(agents));
      const res = await supertest(app).get("/api/pull-requests?refresh=true");

      expect(res.status).toBe(200);
      const agent = res.body.pullRequests[0].agent;
      expect(agent).not.toBeNull();
      // Only id and name — no extra fields
      expect(Object.keys(agent).sort()).toEqual(["id", "name"]);
      expect(agent.id).toBe("agentmgr-uuid-001");
      expect(agent.name).toBe("My Agent");
    });
  });

  // -------------------------------------------------------------------------
  // 6. checksStatus derivation
  // -------------------------------------------------------------------------
  describe("checksStatus derivation", () => {
    async function getChecksStatus(rollup: GhPR["statusCheckRollup"]): Promise<string> {
      const ghPR = makeGhPR({ statusCheckRollup: rollup });

      vi.mocked(execFile).mockImplementation((_cmd, args, _opts, callback) => {
        const cb = callback as (err: unknown, result: { stdout: string; stderr: string }) => void;
        const argsList = args as string[];
        if (argsList.includes("remote")) {
          cb(null, { stdout: "https://github.com/org/myrepo.git\n", stderr: "" });
        } else if (argsList.includes("pr")) {
          cb(null, { stdout: JSON.stringify([ghPR]), stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as ReturnType<typeof execFile>;
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["r.git"] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);

      const app = makeApp(makeAgentManager());
      const res = await supertest(app).get("/api/pull-requests?refresh=true");
      return res.body.pullRequests[0].checksStatus as string;
    }

    it("returns none when statusCheckRollup is null", async () => {
      expect(await getChecksStatus(null)).toBe("none");
    });

    it("returns none when statusCheckRollup is empty", async () => {
      expect(await getChecksStatus([])).toBe("none");
    });

    it("returns passing when all checks succeed", async () => {
      expect(await getChecksStatus([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }])).toBe("passing");
    });

    it("returns failing when any check has FAILURE conclusion", async () => {
      expect(await getChecksStatus([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("failing");
    });

    it("returns pending when any check is IN_PROGRESS", async () => {
      expect(await getChecksStatus([{ status: "IN_PROGRESS" }])).toBe("pending");
    });
  });
});
