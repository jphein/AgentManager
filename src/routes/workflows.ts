import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import express, { type Request, type Response } from "express";
import type { AgentManager } from "../agents";
import { requireNotAgentService } from "../auth";
import { createGrade, type GradeResult } from "../grading";
import { ALLOWED_MODELS, type AllowedModel, DEFAULT_MODEL } from "../guardrails";
import { logger } from "../logger";
import type { MessageBus } from "../messages";
import { registerSecretValue } from "../sanitize";
import { errorMessage } from "../types";
import { REPO_NAME_RE } from "../validation";
import { confidenceFromGrade, gradeGate } from "../workflow-grading";
import {
  checkMemoryForNewWorkflow,
  checkWorkflowAgentLimit,
  detectWorkflowStall,
  enforceWorkflowCostCap,
  WORKFLOW_MAX_AGENTS,
} from "../workflow-resource-manager";
import {
  buildTriagePrompt,
  buildValidationResult,
  clarityFromChecks,
  type TriageChecks,
  verdictFromClarity,
} from "../workflow-triage";
import {
  applyPatToGitConfig,
  canStartClone,
  cloningInProgress,
  extractRepoName,
  isValidGitUrl,
  PERSISTENT_REPOS,
  saveRepoPat,
} from "./repositories";

const execFileAsync = promisify(execFile);

export interface LinearWorkflow {
  id: string;
  linearUrl: string;
  repository: string;
  status:
    | "validating"
    | "rejected"
    | "starting"
    | "running"
    | "awaiting_confirm"
    | "grading"
    | "needs_human"
    | "completed"
    | "failed"
    | "cancelled";
  agents: Array<{ id: string; name: string; role: string }>;
  /** True if user-supplied credentials were provided for this workflow run */
  hasCredentials?: boolean;
  /** Arbitrary metadata written by the manager agent (e.g. issueDetails, costEstimate) */
  metadata?: Record<string, unknown>;
  prUrl?: string;
  error?: string;
  /** INF-1: Pre-run cost estimate in USD. When set, workflow is halted at 2× this value. */
  costEstimate?: number;
  /** Agent ID of the triage agent spawned for basicMode validation */
  triageAgentId?: string;
  /** Agent ID of the grader agent (recorded for identity-bound grade ingestion) */
  graderAgentId?: string;
  /** Ticket validation result from the triage agent (basicMode only) */
  validation?: {
    verdict: "accept" | "accept_with_caveats" | "reject";
    clarity: "high" | "medium" | "low";
    missing: string[];
    suggestions: string[];
    readError?: "not_found" | "forbidden" | "auth_failed" | "rate_limited" | "multi_issue_empty";
    evaluatedAt: string;
  };
  /** Confidence grade from the workflow grader (basicMode only) */
  grade?: GradeResult;
  /** Inverted confidence score 0-100 (higher = better = 100 - grade.numericScore) */
  confidence?: number;
  createdAt: string;
  updatedAt: string;
}

/** AllowedModel imported from central guardrails — see guardrails.ts for authoritative type. */

/** Validate a Linear API key format (lin_api_ prefix, min 32 chars after prefix) */
function isValidLinearApiKey(key: string): boolean {
  return /^lin_api_[A-Za-z0-9_]{32,}$/.test(key);
}

/** Validate a GitHub PAT format (classic ghp_, fine-grained github_pat_, or legacy 40-char hex) */
function isValidGithubPat(pat: string): boolean {
  return /^(ghp_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|[a-f0-9]{40})$/.test(
    pat,
  );
}

/** In-memory workflow store */
const workflows = new Map<string, LinearWorkflow>();

/** Max concurrent workflows */
const MAX_WORKFLOWS = 5;

/** Max total stored workflows (evict oldest terminal workflows beyond this) */
const MAX_STORED_WORKFLOWS = 50;

/** Wall-clock terminal timeout for running workflows — a hung manager pins a slot forever without this. */
export const RUNNING_WALL_CLOCK_TIMEOUT_MS = 60 * 60_000;

/** Supported Linear entity types */
type LinearEntityType = "issue" | "project" | "cycle" | "view";

interface ParsedLinearUrl {
  workspace: string;
  entityType: LinearEntityType;
  /** Issue ID like "TEAM-123", project slug, cycle ID, or view ID */
  entityId: string;
  /** Team prefix extracted from issue IDs (e.g. "TEAM" from "TEAM-123"), or undefined */
  team?: string;
}

/** Parse a broad set of Linear URLs — issues, projects, cycles, views.
 *  Anchored to https://linear.app to prevent spoofed domains. */
function parseLinearUrl(url: string): ParsedLinearUrl | null {
  // Issue: https://linear.app/{workspace}/issue/{TEAM-123}
  const issueMatch = url.match(/^https:\/\/linear\.app\/([\w-]+)\/issue\/([\w]+-\d+)/);
  if (issueMatch) {
    const workspace = issueMatch[1];
    const entityId = issueMatch[2];
    return { workspace, entityType: "issue", entityId, team: entityId.split("-")[0] };
  }

  // Project: https://linear.app/{workspace}/project/{slug-uuid}
  const projectMatch = url.match(/^https:\/\/linear\.app\/([\w-]+)\/project\/([\w-]+)/);
  if (projectMatch) {
    return { workspace: projectMatch[1], entityType: "project", entityId: projectMatch[2] };
  }

  // Cycle: https://linear.app/{workspace}/cycle/{id}
  const cycleMatch = url.match(/^https:\/\/linear\.app\/([\w-]+)\/cycle\/([\w-]+)/);
  if (cycleMatch) {
    return { workspace: cycleMatch[1], entityType: "cycle", entityId: cycleMatch[2] };
  }

  // View (saved filters / custom views): https://linear.app/{workspace}/view/{id}
  const viewMatch = url.match(/^https:\/\/linear\.app\/([\w-]+)\/view\/([\w-]+)/);
  if (viewMatch) {
    return { workspace: viewMatch[1], entityType: "view", entityId: viewMatch[2] };
  }

  return null;
}

/** Reconstruct a clean Linear URL from parsed components (prevents prompt injection via URL) */
function buildSafeLinearUrl(parsed: ParsedLinearUrl): string {
  return `https://linear.app/${parsed.workspace}/${parsed.entityType}/${parsed.entityId}`;
}

/** Evict oldest terminal workflows when the store exceeds MAX_STORED_WORKFLOWS */
function evictStaleWorkflows(): void {
  if (workflows.size <= MAX_STORED_WORKFLOWS) return;
  const terminal = Array.from(workflows.entries())
    .filter(([, w]) => w.status === "completed" || w.status === "failed" || w.status === "cancelled")
    .sort((a, b) => new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime());
  while (workflows.size > MAX_STORED_WORKFLOWS && terminal.length > 0) {
    const oldest = terminal.shift();
    if (oldest) workflows.delete(oldest[0]);
  }
}

export function buildManagerPrompt(
  safeLinearUrl: string,
  repository: string,
  workflowId: string,
  entityType: LinearEntityType = "issue",
): string {
  const entityLabel =
    entityType === "issue" ? "Linear Issue" : `Linear ${entityType.charAt(0).toUpperCase() + entityType.slice(1)}`;

  const entityIntro: Record<LinearEntityType, string> = {
    issue: "Read the Linear issue",
    project: "Read the Linear project and list all its issues",
    cycle: "Read the Linear cycle and list all its issues",
    view: "Read the Linear view and list all matching issues",
  };

  const contextInstructions = `1. **${entityIntro[entityType]}** using the \`/linear\` slash command or MCP tools. Extract **full context**:
   - Title, description (full markdown body), and acceptance criteria
   - **Sub-issues**: Read every sub-issue / child issue — each is part of the scope
   - **Linked issues**: Read related/blocked/blocking issues for context
   - **Attachments**: Download and review all — Slack messages, images, design files, screenshots contain critical requirements
   - **Comments**: Read full comment threads for clarifications, decisions, and scope changes
   - Labels, priority, and estimate metadata${entityType !== "issue" ? "\n   - Prioritize issues by Linear priority and implement in dependency order" : ""}`;

  return `You are the lead engineer for a workflow. Take a ${entityLabel}, understand it fully, implement it, and produce a PR.

## ${entityLabel}: ${safeLinearUrl}
**Repository:** ${repository} | **Workflow ID:** ${workflowId}

## Instructions
${contextInstructions}
2. **Plan** — Read the codebase, create a plan, write it to shared-context as \`workflow-${workflowId.slice(0, 8)}-plan.md\`.
3. **Spawn team** via \`POST /api/agents/batch\`: Engineer (claude-sonnet-4-6, maxTurns: 200) and Reviewer (claude-sonnet-4-6, maxTurns: 30). Sonnet handles routine implementation and review well — only request \`claude-opus-4-8-20260601\` for a sub-task that is genuinely architecturally hard.
4. **Coordinate** — Send engineer the plan, monitor via message bus, get reviewer to review, iterate on feedback.
5. **Grade** — Spawn a grader agent (model: claude-opus-4-8-20260601, maxTurns: 12, role: workflow-grader, read-only). The grader must post ONE result message with metadata:
   \`{"workflowId":"${workflowId}","workflowGrade":{"graderAgentId":"<GRADER AGENT ID>","ticketClarity":"high|medium|low","fixConfidence":"high|medium|low","blastRadius":"isolated|moderate|broad","reasoning":"<2-3 sentences>"}}\`
   The grader must include its own agent ID in the payload. Wait for the backend to post a \`gradeDecision\` message back to you:
   - \`CREATE_PR\` → proceed to step 6.
   - \`NEEDS_HUMAN\` → do NOT create a PR; broadcast a status message with workflowId; stop.
6. **Create PR** via \`gh pr create\` referencing the Linear ${entityType}. Branch: \`feat/TEAM-123-description\`.
7. **Report** — Broadcast a "result" message with PR URL and metadata \`{"workflowId": "${workflowId}"}\`.

## Rules
- Always read attachments (Slack threads, images, docs) — they contain context you cannot skip
- Keep the team small. Reference the Linear URL in the PR. Report blockers as "status" messages.`;
}

/** Resolve a repository from either a bare name or a git URL.
 *  If the URL points to a repo not yet cloned, performs an async bare clone.
 *  Returns the bare repo name or an error string. */
async function resolveRepository(
  repoNameOrUrl: string,
  githubPat?: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (isValidGitUrl(repoNameOrUrl)) {
    const name = extractRepoName(repoNameOrUrl);
    if (!name) return { ok: false, error: "Could not extract repository name from URL" };

    const targetDir = path.join(PERSISTENT_REPOS, name);
    const barePath = fs.existsSync(`${targetDir}.git`) ? `${targetDir}.git` : null;
    const plainPath = fs.existsSync(targetDir) ? targetDir : null;
    const existingPath = barePath || plainPath;

    if (!existingPath) {
      const bareTarget = `${targetDir}.git`;
      if (cloningInProgress.has(bareTarget)) {
        return { ok: false, error: "Repository is currently being cloned. Please try again shortly." };
      }
      if (!canStartClone().allowed) {
        return { ok: false, error: "Too many concurrent clone operations. Please try again shortly." };
      }
      fs.mkdirSync(PERSISTENT_REPOS, { recursive: true });
      cloningInProgress.add(bareTarget);
      try {
        // Pass PAT via credential header instead of embedding in URL to avoid persisting secrets
        const cloneUrl = repoNameOrUrl.trim();
        const args = ["clone", "--bare"];
        if (githubPat && cloneUrl.startsWith("https://")) {
          const encoded = Buffer.from(`oauth2:${githubPat}`).toString("base64");
          args.push("-c", `http.extraHeader=Authorization: Basic ${encoded}`);
        }
        args.push(cloneUrl, bareTarget);
        await execFileAsync("git", args, { encoding: "utf-8", timeout: 120_000 });
        logger.info(`[Workflows] Auto-cloned ${name} from URL`);
      } catch (err) {
        try {
          fs.rmSync(bareTarget, { recursive: true, force: true });
        } catch {}
        return { ok: false, error: `Failed to clone repository: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        cloningInProgress.delete(bareTarget);
      }
    }

    if (githubPat) {
      saveRepoPat(name, githubPat);
      const repoPath = existingPath ?? `${targetDir}.git`;
      applyPatToGitConfig(repoPath, githubPat).catch((err) => {
        logger.warn(`[Workflows] Failed to apply PAT to git config for ${name}: ${err}`);
      });
    }
    return { ok: true, name };
  }

  if (!REPO_NAME_RE.test(repoNameOrUrl) || repoNameOrUrl.length > 100) {
    return {
      ok: false,
      error: "Invalid repository name. Use alphanumeric characters, hyphens, underscores, and dots only.",
    };
  }
  return { ok: true, name: repoNameOrUrl };
}

export function createWorkflowsRouter(agentManager: AgentManager, messageBus: MessageBus) {
  const router = express.Router();

  // ──────────────────────────────────────────────────────────────────────────
  // INF-2: Workflow agent membership tracking for TTL extension.
  // Builds a set of all agent IDs belonging to active workflows (including
  // descendants spawned by the manager via parentId traversal). Cached for
  // 60s to match the cleanupExpired() interval and avoid repeated BFS.
  // ──────────────────────────────────────────────────────────────────────────

  let workflowAgentCache: { ids: Set<string>; expiresAt: number } | null = null;

  /** Return all agent IDs for a specific workflow (manager + all descendants via BFS). */
  function getWorkflowAgentIds(workflow: LinearWorkflow): string[] {
    const ids = new Set<string>(workflow.agents.map((a) => a.id));
    const allAgents = agentManager.list();
    // BFS: include agents spawned by workflow agents (up to MAX_AGENT_DEPTH levels)
    let added = true;
    while (added) {
      added = false;
      for (const agent of allAgents) {
        if (!ids.has(agent.id) && agent.parentId !== undefined && ids.has(agent.parentId)) {
          ids.add(agent.id);
          added = true;
        }
      }
    }
    return [...ids];
  }

  /** Return the union of all active workflow agent IDs (cached). */
  function getActiveWorkflowAgentIds(): Set<string> {
    const now = Date.now();
    if (workflowAgentCache && now < workflowAgentCache.expiresAt) {
      return workflowAgentCache.ids;
    }
    const ids = new Set<string>();
    for (const wf of workflows.values()) {
      // Protect agents in all active states so INF-2 cleanup doesn't evict
      // triage/grader agents while their workflow is still in flight.
      if (wf.status !== "starting" && wf.status !== "running" && wf.status !== "validating" && wf.status !== "grading")
        continue;
      for (const agentId of getWorkflowAgentIds(wf)) ids.add(agentId);
    }
    workflowAgentCache = { ids, expiresAt: now + 60_000 };
    return ids;
  }

  // Register INF-2 membership checker — AgentManager.cleanupExpired() will skip these agents
  agentManager.setWorkflowMembershipChecker((agentId) => getActiveWorkflowAgentIds().has(agentId));

  // ──────────────────────────────────────────────────────────────────────────
  // INF-1 + INF-3: Periodic watchdog — runs every 60s alongside cleanupExpired.
  // Checks all active workflows for cost cap violations and stall conditions.
  // ──────────────────────────────────────────────────────────────────────────

  const watchdogInterval = setInterval(() => {
    // Invalidate cache so watchdog sees fresh agent state
    workflowAgentCache = null;

    // Terminal timeout for validating state (triage agent crash/hang → fail after 5min)
    const VALIDATING_TIMEOUT_MS = 5 * 60_000;
    // Terminal timeout for grading state (grader crash/hang → fail after 10min)
    const GRADING_TIMEOUT_MS = 10 * 60_000;
    for (const [wfId, workflow] of workflows) {
      if (workflow.status === "validating") {
        const age = Date.now() - new Date(workflow.updatedAt).getTime();
        if (age > VALIDATING_TIMEOUT_MS) {
          workflow.status = "failed";
          workflow.error = "Triage timed out — ticket validation did not complete in time.";
          workflow.updatedAt = new Date().toISOString();
          logger.warn(`[workflow-watchdog] Triage timeout for workflow ${wfId}`);
          if (workflow.triageAgentId) {
            agentManager.destroy(workflow.triageAgentId);
          }
        }
        continue;
      }
      if (workflow.status === "grading") {
        const age = Date.now() - new Date(workflow.updatedAt).getTime();
        if (age > GRADING_TIMEOUT_MS) {
          workflow.status = "failed";
          workflow.error = "Grading timed out — confidence grading did not complete in time.";
          workflow.updatedAt = new Date().toISOString();
          logger.warn(`[workflow-watchdog] Grading timeout for workflow ${wfId}`);
          if (workflow.graderAgentId) {
            agentManager.destroy(workflow.graderAgentId);
          }
        }
        continue;
      }
      if (workflow.status !== "running") continue;

      const agentIds = getWorkflowAgentIds(workflow);

      // INF-1: Cost cap enforcement — halt workflow at 2× cost estimate
      if (workflow.costEstimate && workflow.costEstimate > 0) {
        enforceWorkflowCostCap(wfId, agentIds, workflow.costEstimate, agentManager, (workflowId, actualCost, cap) => {
          // Pause all running agents to halt spending
          for (const agentId of agentIds) {
            agentManager.pause(agentId);
          }
          workflow.status = "failed";
          workflow.error =
            `Cost cap exceeded: $${actualCost.toFixed(4)} >= $${cap.toFixed(4)} ` +
            `(${workflow.costEstimate != null ? `estimate $${workflow.costEstimate.toFixed(4)}` : "no estimate"})`;
          workflow.updatedAt = new Date().toISOString();
          logger.warn(`[workflow-watchdog] INF-1: Halted workflow ${workflowId} — cost cap reached`);
        });
      }

      // Skip stall check if workflow was just halted by cost cap
      if (workflow.status !== "running") continue;

      // INF-3: Stall detection — notify orchestrator when all agents idle >10min
      detectWorkflowStall(wfId, agentIds, agentManager, (workflowId, idleMs) => {
        const managerId = workflow.agents[0]?.id;
        if (managerId) {
          messageBus.post({
            from: "workflow-guard",
            fromName: "workflow-guard",
            to: managerId,
            type: "status",
            content:
              `Workflow stall detected: all agents have been idle for ` +
              `${Math.round(idleMs / 60_000)} minute(s). ` +
              "Are you blocked? Please report status or continue working.",
            metadata: { workflowId, idleMs, event: "stall_detected" },
          });
        }
      });

      // Wall-clock terminal timeout for running workflows (closes the gap
      // where stall detection only notifies and never terminates a hung manager).
      const runningAge = Date.now() - new Date(workflow.createdAt).getTime();
      if (runningAge > RUNNING_WALL_CLOCK_TIMEOUT_MS) {
        for (const agentId of agentIds) {
          agentManager.pause(agentId);
        }
        workflow.status = "failed";
        workflow.error = "Workflow exceeded the 60-minute wall-clock limit and was terminated.";
        workflow.updatedAt = new Date().toISOString();
        logger.warn(`[workflow-watchdog] Wall-clock timeout for workflow ${wfId}`);
      }
    }
  }, 60_000);

  // Don't hold the event loop open if the server shuts down
  watchdogInterval.unref();

  /**
   * POST /api/workflows/linear
   * Start a new Linear-to-PR workflow
   */
  router.post("/api/workflows/linear", requireNotAgentService, async (req: Request, res: Response) => {
    try {
      const {
        linearUrl,
        repository,
        repositoryUrl,
        linearApiKey,
        githubPat,
        model,
        maxTurns,
        costEstimate,
        basicMode,
      } = req.body ?? {};

      if (!linearUrl || typeof linearUrl !== "string") {
        res.status(400).json({ error: "linearUrl is required" });
        return;
      }

      // API-1: Validate optional credential fields early (format only — never log values)
      if (linearApiKey !== undefined) {
        if (typeof linearApiKey !== "string" || !isValidLinearApiKey(linearApiKey)) {
          res.status(400).json({ error: "Invalid linearApiKey format. Expected lin_api_... prefix." });
          return;
        }
        registerSecretValue(linearApiKey);
      }

      if (githubPat !== undefined) {
        if (typeof githubPat !== "string" || !isValidGithubPat(githubPat)) {
          res.status(400).json({
            error: "Invalid githubPat format. Expected ghp_..., github_pat_..., or 40-char hex token.",
          });
          return;
        }
        registerSecretValue(githubPat);
      }

      // Accept either repositoryUrl (git URL) or repository (bare name)
      const repoInput = repositoryUrl || repository;
      if (!repoInput || typeof repoInput !== "string") {
        res.status(400).json({ error: "repository or repositoryUrl is required" });
        return;
      }

      // Resolve repository: validates name or auto-clones from URL
      const repoResult = await resolveRepository(
        repoInput.trim(),
        typeof githubPat === "string" ? githubPat : undefined,
      );
      if (!repoResult.ok) {
        res.status(400).json({ error: repoResult.error });
        return;
      }
      const resolvedRepoName = repoResult.name;

      // Validate Linear URL — supports issues, projects, cycles, views
      const parsed = parseLinearUrl(linearUrl);
      if (!parsed) {
        res.status(400).json({
          error:
            "Invalid Linear URL. Supported formats: " +
            "https://linear.app/{workspace}/issue/TEAM-123, " +
            "https://linear.app/{workspace}/project/{slug}, " +
            "https://linear.app/{workspace}/cycle/{id}",
        });
        return;
      }

      // API-1: Validate optional model
      let resolvedModel: AllowedModel = DEFAULT_MODEL;
      if (model !== undefined) {
        if (!ALLOWED_MODELS.includes(model as AllowedModel)) {
          res.status(400).json({ error: `Invalid model. Allowed values: ${ALLOWED_MODELS.join(", ")}` });
          return;
        }
        resolvedModel = model as AllowedModel;
      }

      // API-1: Validate optional maxTurns
      let resolvedMaxTurns = 100;
      if (maxTurns !== undefined) {
        const turns = Number(maxTurns);
        if (!Number.isInteger(turns) || turns < 1 || turns > 500) {
          res.status(400).json({ error: "maxTurns must be an integer between 1 and 500." });
          return;
        }
        resolvedMaxTurns = turns;
      }

      // INF-4: Reject new workflows when system memory is above the threshold
      const memErr = checkMemoryForNewWorkflow();
      if (memErr) {
        res.status(503).json({ error: memErr });
        return;
      }

      // Reconstruct a safe URL from parsed components to prevent prompt injection
      const safeLinearUrl = buildSafeLinearUrl(parsed);

      // Check concurrent workflow limit (include validating/grading so the cap is honest — PR-5/PR-7)
      const active = Array.from(workflows.values()).filter(
        (w) =>
          w.status === "validating" ||
          w.status === "starting" ||
          w.status === "running" ||
          w.status === "grading" ||
          w.status === "awaiting_confirm",
      );
      if (active.length >= MAX_WORKFLOWS) {
        res.status(429).json({
          error: `Maximum ${MAX_WORKFLOWS} concurrent workflows allowed. Wait for an existing workflow to complete.`,
        });
        return;
      }

      // INF-4: Check per-workflow agent limit (1 manager spawned here; sub-agents added later)
      const agentLimitErr = checkWorkflowAgentLimit(1, WORKFLOW_MAX_AGENTS);
      if (agentLimitErr) {
        res.status(503).json({ error: agentLimitErr });
        return;
      }

      const workflowId = crypto.randomUUID();
      const now = new Date().toISOString();

      const workflow: LinearWorkflow = {
        id: workflowId,
        linearUrl: safeLinearUrl,
        repository: resolvedRepoName,
        status: "starting",
        agents: [],
        hasCredentials: !!(linearApiKey || githubPat),
        metadata: {},
        // INF-1: Store cost estimate for cap enforcement (0 = no cap)
        costEstimate: typeof costEstimate === "number" && costEstimate > 0 ? costEstimate : undefined,
        createdAt: now,
        updatedAt: now,
      };

      workflows.set(workflowId, workflow);
      evictStaleWorkflows();

      if (basicMode === true) {
        // Basic mode: spawn a triage agent to validate ticket detail before building.
        // The manager is NOT spawned here — the subscribe seam spawns it after a successful verdict.
        try {
          const triagePrompt = buildTriagePrompt(safeLinearUrl, workflowId);
          const { agent: triageAgent } = agentManager.create({
            prompt: triagePrompt,
            name: `workflow-triage-${workflowId.slice(0, 8)}`,
            model: "claude-haiku-4-5-20251001",
            // 6 turns was too tight: reading the Linear ticket via MCP + posting the
            // verdict message routinely exhausted the budget before the verdict was sent,
            // tripping the 5-min VALIDATING_TIMEOUT_MS watchdog. 15 gives headroom while
            // staying well under the manager budget (Haiku keeps the extra turns cheap).
            maxTurns: 15,
            role: "workflow-triage",
            // Never allow Basic-lane agents to self-merge (security invariant)
          });

          workflow.triageAgentId = triageAgent.id;
          workflow.agents.push({ id: triageAgent.id, name: triageAgent.name, role: "triage" });
          workflow.status = "validating";
          workflow.updatedAt = new Date().toISOString();
          workflowAgentCache = null;

          res.status(201).json({ workflow });
        } catch (err) {
          logger.error(`[Workflows] Failed to spawn triage agent for ${workflowId}: ${errorMessage(err)}`);
          workflow.status = "failed";
          workflow.error = errorMessage(err);
          workflow.updatedAt = new Date().toISOString();
          res.status(500).json({ error: `Failed to start workflow: ${errorMessage(err)}`, workflow });
        }
      } else {
        // Advanced path (default): spawn manager immediately, byte-identical to prior behaviour.
        const managerPrompt = buildManagerPrompt(safeLinearUrl, resolvedRepoName, workflowId, parsed.entityType);

        try {
          const entityLabel = parsed.team
            ? parsed.entityId.toLowerCase()
            : `${parsed.entityType}-${parsed.entityId.slice(0, 8).toLowerCase()}`;
          const managerName = `workflow-${entityLabel}`;
          const { agent } = agentManager.create({
            prompt: managerPrompt,
            name: managerName,
            model: resolvedModel,
            maxTurns: resolvedMaxTurns,
            role: "workflow-manager",
          });

          workflow.agents.push({ id: agent.id, name: managerName, role: "manager" });
          workflow.status = "running";
          workflow.updatedAt = new Date().toISOString();
          // Invalidate INF-2 cache so the new manager is immediately protected from TTL cleanup
          workflowAgentCache = null;

          res.status(201).json({ workflow });
        } catch (err) {
          logger.error(`[Workflows] Failed to spawn manager for ${workflowId}: ${errorMessage(err)}`);
          workflow.status = "failed";
          workflow.error = errorMessage(err);
          workflow.updatedAt = new Date().toISOString();
          res.status(500).json({ error: `Failed to start workflow: ${errorMessage(err)}`, workflow });
        }
      }
    } catch (err) {
      logger.error(`[Workflows] Error starting workflow: ${String(err)}`);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  /**
   * GET /api/workflows
   * List all workflows
   */
  router.get("/api/workflows", (_req: Request, res: Response) => {
    const all = Array.from(workflows.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    res.json(all);
  });

  /**
   * GET /api/workflows/:id
   * Get workflow status with live agent state and aggregated cost
   */
  router.get("/api/workflows/:id", (req: Request<{ id: string }>, res: Response) => {
    const workflow = workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Enrich with live agent status
    const enrichedAgents = workflow.agents.map((a) => {
      const agent = agentManager.get(a.id);
      return {
        ...a,
        status: agent?.status ?? "unknown",
        currentTask: agent?.currentTask,
      };
    });

    // API-3: Aggregate token usage and estimated cost across all workflow agents
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalTokens = 0;
    let estimatedCost = 0;
    for (const a of workflow.agents) {
      const usage = agentManager.getUsage(a.id);
      if (usage) {
        totalTokensIn += usage.tokensIn;
        totalTokensOut += usage.tokensOut;
        totalTokens += usage.tokensTotal;
        estimatedCost += usage.estimatedCost;
      }
    }

    res.json({
      ...workflow,
      agents: enrichedAgents,
      cost: {
        totalTokensIn,
        totalTokensOut,
        totalTokens,
        estimatedCost: Math.round(estimatedCost * 1e6) / 1e6,
      },
    });
  });

  /**
   * GET /api/workflows/:id/logs
   * Aggregate logs from all agents in a workflow
   */
  router.get("/api/workflows/:id/logs", async (req: Request<{ id: string }>, res: Response) => {
    const workflow = workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const tailParam = req.query.tail ? Number.parseInt(req.query.tail as string, 10) : undefined;
    const tail = tailParam && Number.isFinite(tailParam) && tailParam > 0 ? Math.min(tailParam, 1000) : undefined;

    // Filter to a specific agent if requested
    const agentFilter = typeof req.query.agent === "string" ? req.query.agent : undefined;
    const agentsToQuery = agentFilter ? workflow.agents.filter((a) => a.id === agentFilter) : workflow.agents;

    if (agentFilter && agentsToQuery.length === 0) {
      res.status(404).json({ error: "Agent not found in this workflow" });
      return;
    }

    const agentLogs = await Promise.all(
      agentsToQuery.map(async (a) => {
        try {
          const { lines, total } = await agentManager.getLogs(a.id, { tail });
          return { agentId: a.id, agentName: a.name, role: a.role, lines, total };
        } catch (err) {
          logger.warn(`[Workflows] Failed to get logs for agent ${a.id}: ${errorMessage(err)}`);
          return { agentId: a.id, agentName: a.name, role: a.role, lines: [], total: 0 };
        }
      }),
    );

    res.json({ workflowId: req.params.id, agents: agentLogs });
  });

  /**
   * POST /api/workflows/:id/confirm
   * API-4: User confirmation gate — transitions workflow from awaiting_confirm to running.
   * The workflow manager agent is notified via the message bus so it can proceed.
   */
  router.post("/api/workflows/:id/confirm", requireNotAgentService, (req: Request<{ id: string }>, res: Response) => {
    const workflow = workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    if (workflow.status !== "awaiting_confirm") {
      res.status(409).json({
        error: `Cannot confirm workflow with status '${workflow.status}'. Workflow must be in 'awaiting_confirm' state.`,
      });
      return;
    }

    workflow.status = "running";
    workflow.updatedAt = new Date().toISOString();

    // Notify the workflow manager so it can proceed past the confirmation gate
    const manager = workflow.agents.find((a) => a.role === "manager");
    if (manager) {
      messageBus.post({
        from: "platform",
        fromName: "platform",
        to: manager.id,
        type: "info",
        content: "User confirmed. Proceed with workflow execution.",
        metadata: { workflowId: workflow.id, confirmed: true },
      });
    }

    res.json({ workflow });
  });

  /**
   * DELETE /api/workflows/:id
   * Cancel a workflow and destroy its agents
   */
  router.delete("/api/workflows/:id", requireNotAgentService, async (req: Request<{ id: string }>, res: Response) => {
    const workflow = workflows.get(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Destroy all associated agents
    for (const agent of workflow.agents) {
      try {
        await agentManager.destroy(agent.id);
      } catch (err) {
        logger.warn(`[Workflows] Failed to destroy agent ${agent.id}: ${errorMessage(err)}`);
      }
    }

    workflow.status = "cancelled";
    workflow.updatedAt = new Date().toISOString();
    workflowAgentCache = null;

    res.json({ ok: true, workflow });
  });

  // Listen for workflow messages from manager agents
  messageBus.subscribe((msg) => {
    if (!msg.metadata?.workflowId) return;

    const wfId = msg.metadata.workflowId;
    if (typeof wfId !== "string") return;

    const workflow = workflows.get(wfId);
    if (!workflow) return;

    // §5d-security: Identity-bound triage verdict ingestion.
    // MUST sit before the metadata-merge / completion branches so it cannot fall through.
    if (msg.metadata.triageVerdict && workflow.status === "validating") {
      // Reject any verdict not from the recorded triage agent for this workflow.
      if (msg.from !== workflow.triageAgentId || !agentManager.get(msg.from)) {
        logger.warn(`[Workflows] Ignoring triageVerdict from unrecognised agent ${msg.from} for workflow ${wfId}`);
        return;
      }

      const verdict = msg.metadata.triageVerdict as Record<string, unknown>;
      const checks = verdict.checks as TriageChecks | undefined;
      const missing = Array.isArray(verdict.missing) ? (verdict.missing as string[]) : [];
      const suggestions = Array.isArray(verdict.suggestions) ? (verdict.suggestions as string[]) : [];
      const readError =
        typeof verdict.readError === "string"
          ? (verdict.readError as NonNullable<LinearWorkflow["validation"]>["readError"])
          : undefined;

      // Backend computes clarity + verdict from agent-supplied boolean checks.
      // Any non-accept outcome (incl. any readError) → reject; never trust self-assessed verdict.
      let triageVerdict: "accept" | "accept_with_caveats" | "reject" = "reject";
      let clarity: "high" | "medium" | "low" = "low";

      if (!readError && checks) {
        clarity = clarityFromChecks(checks);
        triageVerdict = verdictFromClarity(clarity);
      }

      const validation = buildValidationResult(
        checks ?? { substance: false, goalClarity: false, doneDef: false, scopeSignal: false, actionability: false },
        triageVerdict,
        clarity,
        missing,
        suggestions,
        readError,
      );

      workflow.validation = validation;
      workflow.updatedAt = new Date().toISOString();

      if (triageVerdict === "reject" || readError) {
        // Fail-closed: reject → status rejected, destroy triage agent, do NOT spawn manager.
        workflow.status = "rejected";
        if (workflow.triageAgentId) agentManager.destroy(workflow.triageAgentId);
      } else {
        // Accept: transition to running and spawn the build-team manager.
        workflow.status = "running";
        if (workflow.triageAgentId) agentManager.destroy(workflow.triageAgentId);

        const managerPrompt = buildManagerPrompt(workflow.linearUrl, workflow.repository, workflow.id, "issue");
        const entityLabel = `workflow-${workflow.id.slice(0, 8)}`;
        try {
          const { agent: manager } = agentManager.create({
            prompt: managerPrompt,
            name: entityLabel,
            model: DEFAULT_MODEL,
            maxTurns: 100,
            role: "workflow-manager",
            // Never allow Basic-lane agents to self-merge (security invariant)
          });
          workflow.agents.push({ id: manager.id, name: entityLabel, role: "manager" });
          workflowAgentCache = null;
        } catch (err) {
          logger.error(`[Workflows] Failed to spawn manager after triage accept: ${errorMessage(err)}`);
          workflow.status = "failed";
          workflow.error = errorMessage(err);
        }
      }

      workflow.updatedAt = new Date().toISOString();
      return;
    }

    // §5e: Identity-bound workflowGrade ingestion.
    // Handles: grader reports grade → backend runs gradeGate → posts gradeDecision to manager.
    if (msg.metadata.workflowGrade && workflow.status === "grading") {
      const raw = msg.metadata.workflowGrade as Record<string, unknown>;
      const reportedGraderAgentId = typeof raw.graderAgentId === "string" ? raw.graderAgentId : undefined;

      // Reject grade from any agent not recorded as this workflow's grader.
      if (
        !reportedGraderAgentId ||
        reportedGraderAgentId !== workflow.graderAgentId ||
        !agentManager.get(reportedGraderAgentId)
      ) {
        logger.warn(`[Workflows] Ignoring workflowGrade from unrecognised agent ${msg.from} for workflow ${wfId}`);
        return;
      }

      // Build a real GradeResult via createGrade (validates axes, computes numericScore).
      let grade: GradeResult;
      try {
        grade = createGrade({
          taskId: workflow.id,
          agentId: reportedGraderAgentId,
          ticketClarity: raw.ticketClarity as "high" | "medium" | "low",
          fixConfidence: raw.fixConfidence as "high" | "medium" | "low",
          blastRadius: raw.blastRadius as "isolated" | "moderate" | "broad",
          reasoning: typeof raw.reasoning === "string" ? raw.reasoning : undefined,
        });
      } catch (err) {
        logger.warn(`[Workflows] Invalid workflowGrade payload for ${wfId}: ${errorMessage(err)}`);
        workflow.status = "failed";
        workflow.error = "Grader returned invalid grade payload.";
        workflow.updatedAt = new Date().toISOString();
        return;
      }

      // Store grade + inverted confidence (higher = better for display).
      workflow.grade = grade;
      workflow.confidence = confidenceFromGrade(grade);
      workflow.updatedAt = new Date().toISOString();

      const decision = gradeGate(grade);

      // Post gradeDecision back to the manager so it can act.
      const manager = workflow.agents.find((a) => a.role === "manager");
      if (manager) {
        messageBus.post({
          from: "platform",
          fromName: "platform",
          to: manager.id,
          type: "info",
          content: `Grade decision: ${decision}. Risk: ${grade.overallRisk}. ${grade.reasoning ?? ""}`,
          metadata: { workflowId: wfId, gradeDecision: decision, overallRisk: grade.overallRisk },
        });
      }

      if (decision === "NEEDS_HUMAN") {
        // High risk — withhold PR, no retry in v1.
        workflow.status = "needs_human";
        workflow.updatedAt = new Date().toISOString();
        if (workflow.graderAgentId) agentManager.destroy(workflow.graderAgentId);
      }
      // If CREATE_PR: status stays 'grading' until the completion handler sees a PR URL + valid grade.
      return;
    }

    // Grader spawned: manager reports grader agent ID so backend can record it for identity binding.
    // Also transitions workflow to 'grading' status.
    if (msg.metadata.workflowGraderSpawned && typeof msg.metadata.workflowGraderSpawned === "string") {
      workflow.graderAgentId = msg.metadata.workflowGraderSpawned;
      workflow.status = "grading";
      workflow.updatedAt = new Date().toISOString();
      return;
    }

    // Metadata update: manager writes issueDetails/costEstimate before awaiting_confirm
    if (msg.metadata.workflowMetadata && typeof msg.metadata.workflowMetadata === "object") {
      workflow.metadata = { ...workflow.metadata, ...(msg.metadata.workflowMetadata as Record<string, unknown>) };
      workflow.updatedAt = new Date().toISOString();
    }

    // §5e grade-aware completion: PR-URL result only completes when a passing grade exists.
    // While status==='grading' without a grade (or high-risk grade), ignore PR-URL results.
    if (msg.type === "result") {
      const prMatch = msg.content.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
      if (prMatch) {
        const hasPassingGrade = workflow.grade && gradeGate(workflow.grade) === "CREATE_PR";
        if (workflow.status === "grading" && !hasPassingGrade) {
          // Grade not yet recorded or high-risk — do NOT complete.
          logger.warn(`[Workflows] Ignoring PR-URL result for ${wfId}: no passing grade yet`);
          return;
        }
        workflow.prUrl = prMatch[0];
        workflow.status = "completed";
        workflow.updatedAt = new Date().toISOString();
      }
    }
  });

  return router;
}

/** Test-only: clear the in-memory workflow store between tests. */
export function _clearWorkflowsForTest(): void {
  workflows.clear();
}

/** Test-only: inject a workflow directly into the store (for concurrency/security tests). */
export function _injectWorkflowForTest(workflow: LinearWorkflow): void {
  workflows.set(workflow.id, workflow);
}

/** Test-only: apply wall-clock timeout check to all running workflows in the store.
 *  Simulates one watchdog tick without needing to wait for the setInterval. */
export function _runWallClockTimeoutCheckForTest(): void {
  for (const [_wfId, workflow] of workflows) {
    if (workflow.status !== "running") continue;
    const age = Date.now() - new Date(workflow.createdAt).getTime();
    if (age > RUNNING_WALL_CLOCK_TIMEOUT_MS) {
      workflow.status = "failed";
      workflow.error = "Workflow exceeded the 60-minute wall-clock limit and was terminated.";
      workflow.updatedAt = new Date().toISOString();
    }
  }
}
