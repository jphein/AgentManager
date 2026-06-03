import type { ChildProcess } from "node:child_process";
import type { Request } from "express";
import type { MessageType, StreamEvent } from "./shared/types";

export type {
  Agent,
  AgentDefinition,
  AgentMessage,
  AgentMetadata,
  AgentStateEvent,
  AgentStatus,
  AgentUsage,
  AssignmentDecision,
  CreateAgentRequest,
  MessageType,
  OrchestratorEvent,
  PromptAttachment,
  StreamEvent,
  TaskMessage,
  TaskNode,
  TaskPriority,
  TaskResult,
  TaskStatus,
} from "./shared/types";
export { errorMessage } from "./shared/types";

/** Valid message types for runtime validation */
export const VALID_MESSAGE_TYPES: MessageType[] = ["task", "result", "question", "info", "status", "interrupt"];

/** Server-only: Internal agent process tracking state */
export interface AgentProcess {
  agent: import("./shared/types").Agent;
  proc: ChildProcess | null;
  lineBuffer: string;
  listeners: Set<(event: StreamEvent) => void>;
  /** Track which API message IDs we have already counted usage for. */
  seenMessageIds: Set<string>;
  /** WI-1: Prevents multiple setImmediate scheduling for line processing. */
  processingScheduled: boolean;
  /** WI-1: Accumulated JSONL lines for batched disk write. */
  persistBatch: string;
  /** WI-1: Timer for coalesced disk writes (16ms window). */
  persistTimer: ReturnType<typeof setTimeout> | null;
  /** WI-1: Events buffered for coalesced listener notification. */
  listenerBatch: StreamEvent[];
  /** WI-4: Consecutive stall detection count - escalates to error after threshold. */
  stallCount: number;
  /** Ring buffer of recent events for fast reconnect replay (avoids disk reads). */
  eventBuffer: StreamEvent[];
  /** Total number of events ever appended (used to compute ring buffer offset). */
  eventBufferTotal: number;
  /** Session-level cost accumulated from assistant events (for result reconciliation). */
  sessionEstimatedCost?: number;
  /** Session-level input tokens accumulated from assistant events. */
  sessionTokensIn?: number;
  /** Session-level output tokens accumulated from assistant events. */
  sessionTokensOut?: number;
  /** Path to the temporary JSON schema file written for --json-schema. */
  jsonSchemaPath?: string;
  /** True after a soft-stall notification has been sent to avoid duplicate UI alerts. */
  softStallNotified?: boolean;
}

export interface AuthPayload {
  sub: string;
  iat: number;
  exp: number;
  agentId?: string;
}

/** Express Request with authenticated user context attached by authMiddleware */
export interface AuthenticatedRequest extends Request {
  user?: AuthPayload;
}
