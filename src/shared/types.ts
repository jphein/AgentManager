/**
 * Shared type definitions used by both server and UI.
 * These types define the domain model and API contracts shared between backend and frontend.
 * Keep this file free of runtime code (exports only types and interfaces).
 */

// ============================================================================
// Agent Types
// ============================================================================

export type AgentStatus =
  | "starting"
  | "running"
  | "idle"
  | "error"
  | "restored"
  | "destroying"
  | "killing"
  | "paused"
  | "stalled"
  | "disconnected"
  | "reconnecting";

export interface AgentUsage {
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  tokenLimit: number;
  tokensRemaining: number;
  estimatedCost: number;
  model: string;
  sessionStart: string;
  /** Input tokens from the most recent API turn only — used for context window gauge. */
  lastTurnTokensIn?: number;
}

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  workspaceDir: string;
  /** If true, Claude CLI runs with --dangerously-skip-permissions for this agent. */
  dangerouslySkipPermissions?: boolean;
  /** Per-agent spend cap in USD passed as --max-budget-usd to the Claude CLI. */
  maxBudgetUsd?: number;
  /** Agent effort level passed as --effort to the Claude CLI. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Permission mode passed as --permission-mode. When set, replaces --dangerously-skip-permissions. */
  permissionMode?: "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
  claudeSessionId?: string;
  createdAt: string;
  lastActivity: string;
  model: string;
  role?: string;
  capabilities?: string[];
  currentTask?: string;
  parentId?: string;
  /** Layer 4: Spawn depth, set immutably at creation time. Depth 1 = top-level agent. */
  depth: number;
  /** Cached git info (populated asynchronously after spawn). */
  gitBranch?: string;
  gitRepo?: string;
  gitWorktree?: string;
  /** When true, agent is automatically destroyed after its process exits cleanly
   *  and no pending messages remain. Used for short-lived review/judge agents. */
  ephemeral?: boolean;
  /** When true, this agent is allowed to call the merge-gate API to merge PRs.
   *  By default, agent-service tokens are blocked from merging. */
  allowMergeGate?: boolean;
  /** ISO timestamp until which this agent should be retained even when idle.
   *  Used by parent agents to keep child agents alive while waiting for instructions.
   *  Cleanup still respects SESSION_TTL_MS as an absolute ceiling. */
  retainUntil?: string;
  /** Tools the Claude CLI is allowed to use (--allowedTools). Omit to allow all. */
  allowedTools?: string[];
  /** Tools the Claude CLI is not allowed to use (--disallowedTools). */
  disallowedTools?: string[];
  /** Fallback model to use when the primary model is unavailable (--fallback-model). */
  fallbackModel?: string;
  /** Allowlist of MCP server names loaded for this agent (--strict-mcp-config).
   *  Omit to load the global server set. */
  mcpServers?: string[];
  /** Cumulative token usage across all sessions for this agent. */
  usage?: {
    tokensIn: number;
    tokensOut: number;
    estimatedCost: number;
    /** Cumulative total tokens (in+out) across all contexts, never reset by clear-context. */
    totalTokensSpent: number;
    /** Cumulative input tokens across all contexts, never reset by clear-context. */
    totalTokensIn?: number;
    /** Cumulative output tokens across all contexts, never reset by clear-context. */
    totalTokensOut?: number;
    /** Count of API turns (unique assistant message events), used for cost-per-turn anomaly detection. */
    apiTurns?: number;
    /** Input tokens from the most recent API turn only — snapshot for context window gauge.
     *  Unlike tokensIn (cumulative), this stays bounded by the model context limit. */
    lastTurnTokensIn?: number;
  };
  /** Wall-clock duration of the last completed turn in milliseconds (from CLI result event). */
  turnDurationMs?: number;
  /** Duration of API calls within the last completed turn in milliseconds (from CLI result event). */
  apiDurationMs?: number;
  /** Number of turns completed in the last session (from CLI result event). */
  numTurns?: number;
  /** Actual model used by the CLI (from system/init event). May differ from `model` if a fallback was applied. */
  actualModel?: string;
  /** Tools active in the current session (from system/init event). */
  activeTools?: string[];
  /** JSON schema for structured output (from CreateAgentRequest). Stored so message() can re-pass the flag. */
  jsonSchema?: Record<string, unknown>;
  /** Custom sub-agent definitions passed as --agents to the CLI. */
  agents?: Record<string, AgentDefinition>;
  /** Parsed structured result from the agent's final output, populated when jsonSchema was set. */
  structuredResult?: Record<string, unknown>;
  /** If set, this agent was forked from the given agent's session (P2-15). */
  forkedFromId?: string;
}

export interface AgentMetadata {
  pid: number | null;
  uptime: number;
  workingDir: string;
  repo: string | null;
  branch: string | null;
  worktreePath: string | null;
  tokensIn: number;
  tokensOut: number;
  estimatedCost: number;
  model: string;
  sessionId: string | null;
  /** Input tokens from the most recent API turn — used for context window gauge. */
  lastTurnTokensIn?: number;
}

export interface CreateAgentRequest {
  prompt: string;
  name?: string;
  model?: string;
  maxTurns?: number;
  role?: string;
  capabilities?: string[];
  parentId?: string;
  attachments?: PromptAttachment[];
  /** When true, passes --dangerously-skip-permissions to the Claude CLI, bypassing all
   *  permission confirmations. Defaults to false (agents must confirm tool use). */
  dangerouslySkipPermissions?: boolean;
  /** When true, agent is automatically destroyed after its process exits cleanly
   *  and no pending messages remain. Used for short-lived review/judge agents. */
  ephemeral?: boolean;
  /** When true, this agent is allowed to call the merge-gate API to merge PRs.
   *  By default, agent-service tokens are blocked from merging. */
  allowMergeGate?: boolean;
  /** Per-agent spend cap in USD. When set, passes --max-budget-usd to the Claude CLI. */
  maxBudgetUsd?: number;
  /** Tools the Claude CLI is allowed to use (--allowedTools). Omit to allow all. */
  allowedTools?: string[];
  /** Tools the Claude CLI is not allowed to use (--disallowedTools). */
  disallowedTools?: string[];
  /** Fallback model to use when the primary model is unavailable (--fallback-model). */
  fallbackModel?: string;
  /** Allowlist of MCP server names this agent should load. When set, the CLI runs
   *  with --mcp-config + --strict-mcp-config so only these servers' tool defs are
   *  injected (saves input tokens). Omit to load the global server set. */
  mcpServers?: string[];
  /** Internal: resolved path to the workspace-scoped MCP config file. Runtime
   *  only — derived from mcpServers, not provided by API callers. */
  mcpConfigPath?: string;
  /** Agent effort level passed as --effort to the Claude CLI. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Optional system prompt to append, passed as --append-system-prompt. Runtime only, not stored on Agent. */
  appendSystemPrompt?: string;
  /** Permission mode passed as --permission-mode. When set, replaces --dangerously-skip-permissions. */
  permissionMode?: "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
  /** JSON schema for structured output (--json-schema). When set, the CLI is told to output conforming JSON
   *  and the result is parsed into agent.structuredResult. */
  jsonSchema?: Record<string, unknown>;
  /** Custom sub-agent definitions passed as --agents to Claude CLI.
   *  Keys are archetype names; values define the sub-agent behaviour. */
  agents?: Record<string, AgentDefinition>;
  /** Resume a specific Claude session by ID (--session-id). */
  sessionId?: string;
  /** When true, passes --no-session-persistence so the session is not saved to disk. */
  noSessionPersistence?: boolean;
  /** Fork from an existing session by its Claude session ID (--fork-session). */
  forkSessionId?: string;
  /** ID of the source agent when forking (used to set forkedFromId on the new agent). */
  forkedFromId?: string;
}

/** Definition for a Claude CLI sub-agent archetype, passed via --agents. */
export interface AgentDefinition {
  /** When to delegate to this sub-agent. */
  description?: string;
  /** System prompt / behaviour for the sub-agent. */
  prompt?: string;
  /** Tools the sub-agent is allowed to use. */
  tools?: string[];
  /** Model for the sub-agent. */
  model?: string;
  /** Effort level for the sub-agent. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Max turns for the sub-agent. */
  maxTurns?: number;
  /** Tools the sub-agent is not allowed to use. */
  disallowedTools?: string[];
  /** Permission mode for the sub-agent. */
  permissionMode?: "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
  /** Hook configuration for the sub-agent. */
  hooks?: Record<string, unknown>;
  /** If true, run as a background agent. */
  background?: boolean;
}

export interface PromptAttachment {
  name: string;
  type: "image" | "file";
  /** Data URL for images, text content for files */
  data: string;
  mime: string;
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageType = "task" | "result" | "question" | "info" | "status" | "interrupt";

export interface AgentMessage {
  id: string;
  from: string;
  fromName?: string;
  to?: string;
  channel?: string;
  type: MessageType;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  readBy: string[];
  excludeRoles?: string[];
  /** When true, message survives TTL eviction and bulk clear operations. */
  pinned?: boolean;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: string | Record<string, unknown>;
  tool?: string;
  content?: string;
  result?: string;
  text?: string;
  exitCode?: number;
  /** Platform-injected ISO timestamp — set when the event is first batched. */
  _ts?: string;
  /** Platform-injected monotonic global event index — set when the event is first
   *  batched. Distinguishes genuinely-distinct events with identical content so the
   *  client's content fingerprint does not false-dedup them (FIX-7). */
  _idx?: number;
  [key: string]: unknown;
}

// ============================================================================
// Task Types
// ============================================================================

export type TaskStatus = "pending" | "assigned" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export type TaskPriority = 0 | 1 | 2 | 3 | 4; // 0=none, 1=urgent, 2=high, 3=normal, 4=low

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  ownerAgentId: string | null;
  /** Parent goal/task that spawned this task. */
  parentTaskId: string | null;
  /** Typed input data for the task. */
  input: Record<string, unknown> | null;
  /** Schema describing expected output shape. */
  expectedOutput: Record<string, unknown> | null;
  /** Human-readable acceptance criteria. */
  acceptanceCriteria: string | null;
  /** Capability tags required to handle this task. */
  requiredCapabilities: string[];
  /** IDs of tasks that must complete before this task can start. */
  dependsOn: string[];
  /** Optimistic lock version - incremented on every write. */
  version: number;
  /** Number of times this task has been retried after failure. */
  retryCount: number;
  maxRetries: number;
  /** Timeout in ms for task execution. */
  timeoutMs: number | null;
  /** Error message if status is 'failed'. */
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Schema for a structured task result returned by an agent. */
export interface TaskResult {
  taskId: string;
  status: "completed" | "failed";
  output: Record<string, unknown> | null;
  confidence: "high" | "medium" | "low";
  durationMs: number;
  errorMessage?: string;
}

/** Schema for a structured task assignment message. */
export interface TaskMessage {
  taskId: string;
  type: "assignment" | "reassignment" | "cancellation" | "blocked_notification" | "unblocked_notification";
  title: string;
  description: string;
  input: Record<string, unknown> | null;
  expectedOutput: Record<string, unknown> | null;
  successCriteria: string | null;
  timeoutMs: number | null;
}

// ============================================================================
// Orchestrator Types
// ============================================================================

export interface OrchestratorEvent {
  type: string;
  timestamp: string;
  details: Record<string, unknown>;
}

export interface AssignmentDecision {
  taskId: string;
  agentId: string;
  score: number;
  reason: string;
}

// ============================================================================
// SSE Push: Agent State Events
// ============================================================================

/** Events pushed over GET /api/agents/events to replace dashboard polling. */
export type AgentStateEvent =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "agent_created"; agent: Agent }
  | { type: "agent_updated"; agent: Agent }
  | { type: "agent_destroyed"; agentId: string };

// ============================================================================
// Utilities
// ============================================================================

/** Safely extract an error message from an unknown catch value */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
