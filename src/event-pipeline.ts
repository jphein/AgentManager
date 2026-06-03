import { createReadStream } from "node:fs";
import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { EVENT_FILE_TRUNCATE_THRESHOLD, EVENT_RING_BUFFER_SIZE, MAX_PERSISTED_EVENTS } from "./config";
import { logger } from "./logger";
import { EVENTS_DIR, saveAgentState } from "./persistence";
import { sanitizeEvent } from "./sanitize";
import type { Agent, AgentProcess, StreamEvent } from "./types";
import { errorMessage } from "./types";
import type { AgentRegistry, UsageTracker } from "./usage-tracker";
import { estimateCost } from "./usage-tracker";

export class EventPipeline {
  constructor(
    private registry: AgentRegistry,
    private usageTracker: UsageTracker,
    /** Shared write-queue map owned by AgentManager; EventPipeline appends to it. */
    private writeQueues: Map<string, Promise<void>>,
    /** Callback to notify SSE listeners of agent metadata changes. */
    private onAgentUpdated: (id: string, agent: Agent, immediate: boolean) => void,
  ) {}

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  /** Route an incoming StreamEvent: update metadata synchronously, then batch
   *  for disk persistence and listener notification. */
  handleEvent(id: string, event: StreamEvent): void {
    const agentProc = this.registry.get(id);
    if (!agentProc) return;

    this.updateSessionId(event, agentProc);
    this.updateTokenUsage(event, agentProc);

    if (event.type === "system" && event.subtype === "api_retry") {
      logger.warn("[agents] API rate limit retry", {
        agentId: id,
        attempt: event.attempt,
        maxRetries: event.max_retries,
        retryDelayMs: event.retry_delay_ms,
        errorStatus: event.error_status,
        error: event.error,
      });
    }

    if (event.type === "system" && event.subtype === "compact_boundary") {
      logger.info("[agents] Context compact boundary", { agentId: id });
    }

    if (event.type === "system" && event.subtype === "task_started") {
      logger.info("[agents] Sub-task started", { agentId: id, content: event.content });
    }

    if (event.type === "system" && event.subtype === "task_notification") {
      logger.info("[agents] Sub-task notification", { agentId: id, content: event.content });
    }

    if (event.type === "stream_event") {
      this.emitTransientEvent(event, agentProc);
      return;
    }

    this.batchEvent(event, agentProc);
  }

  // ---------------------------------------------------------------------------
  // Ring buffer read helpers
  // ---------------------------------------------------------------------------

  /** Read the in-memory ring buffer in insertion order. */
  readEventBuffer(agentProc: AgentProcess): StreamEvent[] {
    const { eventBuffer, eventBufferTotal } = agentProc;
    const len = eventBuffer.length;
    if (len === 0) return [];
    if (eventBufferTotal <= EVENT_RING_BUFFER_SIZE) return eventBuffer.slice();
    const start = eventBufferTotal % len;
    return [...eventBuffer.slice(start), ...eventBuffer.slice(0, start)];
  }

  /** Hybrid event reader: ring buffer hot path, disk cold path. */
  async readPersistedEvents(id: string): Promise<{ events: StreamEvent[]; baseIndex: number }> {
    const agentProc = this.registry.get(id);
    if (agentProc && agentProc.eventBufferTotal > 0) {
      const events = this.readEventBuffer(agentProc);
      const baseIndex = Math.max(0, agentProc.eventBufferTotal - events.length);
      return { events, baseIndex };
    }

    const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
    try {
      await stat(filePath);
    } catch {
      return { events: [], baseIndex: 0 };
    }

    try {
      const events: StreamEvent[] = [];
      const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as StreamEvent);
        } catch {
          // Skip malformed lines
        }
      }

      const diskCount = events.length;

      if (events.length > MAX_PERSISTED_EVENTS) {
        events.splice(0, events.length - MAX_PERSISTED_EVENTS);
      }

      if (agentProc) {
        const L = Math.min(diskCount, EVENT_RING_BUFFER_SIZE);
        const bufferEvents = events.slice(-L);
        const buf = new Array<StreamEvent>(L);
        for (let i = 0; i < L; i++) {
          buf[(diskCount - L + i) % L] = bufferEvents[i];
        }
        agentProc.eventBuffer = buf;
        agentProc.eventBufferTotal = diskCount;
      }

      const baseIndex = Math.max(0, diskCount - events.length);
      return { events, baseIndex };
    } catch (err: unknown) {
      logger.warn("[agents] Failed to read persisted events", { agentId: id, error: errorMessage(err) });
      return { events: [], baseIndex: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Flush / persistence
  // ---------------------------------------------------------------------------

  /** Flush batched event persistence and listener notifications for an agent. */
  flushEventBatch(id: string, agentProc: AgentProcess): void {
    if (agentProc.persistTimer) {
      clearTimeout(agentProc.persistTimer);
      agentProc.persistTimer = null;
    }

    const batch = agentProc.persistBatch;
    agentProc.persistBatch = "";
    if (batch) {
      const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
      const prev = this.writeQueues.get(id) ?? Promise.resolve();
      const next = prev
        .then(() =>
          appendFile(filePath, batch).catch((err: unknown) => {
            logger.warn("[agents] Failed to persist events", { agentId: id, error: errorMessage(err) });
          }),
        )
        .then(() => {
          if (this.writeQueues.get(id) === next) {
            this.writeQueues.set(id, Promise.resolve());
          }
        });
      this.writeQueues.set(id, next);
    }

    const events = agentProc.listenerBatch;
    agentProc.listenerBatch = [];
    if (events.length > 0) {
      for (const event of events) {
        for (const listener of agentProc.listeners) {
          try {
            listener(event);
          } catch (err: unknown) {
            logger.warn("[agents] Listener error", { error: errorMessage(err) });
          }
        }
      }
    }
  }

  /** Truncate oversized event files to prevent unbounded growth on GCS FUSE. */
  truncateEventFiles(agentIds: Iterable<string>): void {
    for (const id of agentIds) {
      const filePath = path.join(EVENTS_DIR, `${id}.jsonl`);
      const prev = this.writeQueues.get(id) ?? Promise.resolve();
      const next = prev.then(async () => {
        try {
          const fileStat = await stat(filePath).catch(() => null);
          if (!fileStat) return;
          if (fileStat.size < EVENT_FILE_TRUNCATE_THRESHOLD * 200) return;
          const data = await readFile(filePath, "utf-8");
          const lines = data.split("\n").filter((l) => l.trim());
          if (lines.length <= EVENT_FILE_TRUNCATE_THRESHOLD) return;
          const trimmed = lines.slice(-MAX_PERSISTED_EVENTS);
          const tmpPath = `${filePath}.tmp.${Date.now()}`;
          await writeFile(tmpPath, `${trimmed.join("\n")}\n`);
          await rename(tmpPath, filePath);
          logger.info("[agents] Truncated event file", { agentId: id, before: lines.length, after: trimmed.length });
        } catch (err: unknown) {
          logger.warn("[agents] Failed to truncate events", { agentId: id, error: errorMessage(err) });
        }
      });
      this.writeQueues.set(id, next);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emitTransientEvent(event: StreamEvent, agentProc: AgentProcess): void {
    const now = new Date().toISOString();
    agentProc.agent.lastActivity = now;
    if (!event._ts) event._ts = now;
    agentProc.listenerBatch.push(event);
    const id = agentProc.agent.id;
    if (!agentProc.persistTimer) {
      agentProc.persistTimer = setTimeout(() => this.flushEventBatch(id, agentProc), 16);
    }
  }

  private updateSessionId(event: StreamEvent, agentProc: AgentProcess): void {
    if (event.type === "system" && event.subtype === "init") {
      if (event.session_id) agentProc.agent.claudeSessionId = event.session_id as string;
      if (event.model) agentProc.agent.actualModel = event.model as string;
      if (Array.isArray(event.tools)) agentProc.agent.activeTools = event.tools as string[];
      saveAgentState(agentProc.agent);
      this.onAgentUpdated(agentProc.agent.id, agentProc.agent, true);
    }
  }

  private updateTokenUsage(event: StreamEvent, agentProc: AgentProcess): void {
    if (event.type === "result") {
      this.reconcileResultEvent(event, agentProc);
      return;
    }

    if (event.type !== "assistant") return;

    if (event.subtype === "text" || event.subtype === "tool_use") {
      agentProc.softStallNotified = false;
      if (agentProc.agent.status === "stalled") {
        agentProc.stallCount = 0;
        agentProc.agent.status = "running";
        saveAgentState(agentProc.agent);
        this.onAgentUpdated(agentProc.agent.id, agentProc.agent, true);
      }
    }

    const msg =
      typeof event.message === "object" && event.message !== null
        ? (event.message as Record<string, unknown>)
        : undefined;
    const msgId = msg?.id as string | undefined;
    const usage = msg?.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;

    if (!msgId && usage) {
      logger.debug("[usage] assistant event missing message.id — tokens not counted", { agentId: agentProc.agent.id });
    }

    if (msgId && usage && !agentProc.seenMessageIds.has(msgId)) {
      agentProc.seenMessageIds.add(msgId);

      if (agentProc.seenMessageIds.size > 1000) {
        const toDelete = agentProc.seenMessageIds.size - 500;
        let deleted = 0;
        for (const msgKey of agentProc.seenMessageIds) {
          if (deleted >= toDelete) break;
          agentProc.seenMessageIds.delete(msgKey);
          deleted++;
        }
      }

      const tokensIn =
        (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      const tokensOut = usage.output_tokens ?? 0;
      const cost = estimateCost(agentProc.agent.model, usage);

      agentProc.sessionEstimatedCost = (agentProc.sessionEstimatedCost ?? 0) + cost;
      agentProc.sessionTokensIn = (agentProc.sessionTokensIn ?? 0) + tokensIn;
      agentProc.sessionTokensOut = (agentProc.sessionTokensOut ?? 0) + tokensOut;

      if (tokensIn > 0 || tokensOut > 0) {
        const prev = agentProc.agent.usage ?? {
          tokensIn: 0,
          tokensOut: 0,
          estimatedCost: 0,
          totalTokensSpent: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          apiTurns: 0,
          lastTurnTokensIn: 0,
        };
        agentProc.agent.usage = {
          tokensIn: prev.tokensIn + tokensIn,
          tokensOut: prev.tokensOut + tokensOut,
          estimatedCost: prev.estimatedCost + cost,
          totalTokensSpent: prev.totalTokensSpent + tokensIn + tokensOut,
          totalTokensIn: (prev.totalTokensIn ?? 0) + tokensIn,
          totalTokensOut: (prev.totalTokensOut ?? 0) + tokensOut,
          apiTurns: (prev.apiTurns ?? 0) + 1,
          lastTurnTokensIn: tokensIn,
        };
        saveAgentState(agentProc.agent);
        this.onAgentUpdated(agentProc.agent.id, agentProc.agent, false);
        this.usageTracker.upsertCostTracker(agentProc);
      }
    }
  }

  private reconcileResultEvent(event: StreamEvent, agentProc: AgentProcess): void {
    const durationMs = typeof event.duration_ms === "number" ? event.duration_ms : undefined;
    const durationApiMs = typeof event.duration_api_ms === "number" ? event.duration_api_ms : undefined;
    const numTurns = typeof event.num_turns === "number" ? event.num_turns : undefined;

    if (durationMs !== undefined) agentProc.agent.turnDurationMs = durationMs;
    if (durationApiMs !== undefined) agentProc.agent.apiDurationMs = durationApiMs;
    if (numTurns !== undefined) agentProc.agent.numTurns = numTurns;

    const totalCostUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined;
    const rawUsage =
      typeof event.usage === "object" && event.usage !== null ? (event.usage as Record<string, unknown>) : undefined;

    if (totalCostUsd == null && rawUsage == null) {
      if (durationMs !== undefined || durationApiMs !== undefined || numTurns !== undefined) {
        saveAgentState(agentProc.agent);
      }
      return;
    }

    const prev = agentProc.agent.usage ?? {
      tokensIn: 0,
      tokensOut: 0,
      estimatedCost: 0,
      totalTokensSpent: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      apiTurns: 0,
      lastTurnTokensIn: 0,
    };

    let costDelta = 0;
    let tokenInDelta = 0;
    let tokenOutDelta = 0;

    if (totalCostUsd != null) {
      costDelta = totalCostUsd - (agentProc.sessionEstimatedCost ?? 0);
      agentProc.sessionEstimatedCost = totalCostUsd;
    }

    if (rawUsage) {
      const toNum = (v: unknown) => (typeof v === "number" ? v : 0);
      const authoritativeIn =
        toNum(rawUsage.input_tokens) +
        toNum(rawUsage.cache_creation_input_tokens) +
        toNum(rawUsage.cache_read_input_tokens);
      const authoritativeOut = toNum(rawUsage.output_tokens);

      tokenInDelta = authoritativeIn - (agentProc.sessionTokensIn ?? 0);
      tokenOutDelta = authoritativeOut - (agentProc.sessionTokensOut ?? 0);
      agentProc.sessionEstimatedCost = totalCostUsd ?? agentProc.sessionEstimatedCost;
      agentProc.sessionTokensIn = authoritativeIn;
      agentProc.sessionTokensOut = authoritativeOut;
    }

    if (costDelta === 0 && tokenInDelta === 0 && tokenOutDelta === 0) return;

    const nextEstimatedCost = Math.max(0, prev.estimatedCost + costDelta);
    const nextTokensIn = Math.max(0, prev.tokensIn + tokenInDelta);
    const nextTokensOut = Math.max(0, prev.tokensOut + tokenOutDelta);
    const nextTotalTokensIn = Math.max(0, (prev.totalTokensIn ?? 0) + tokenInDelta);
    const nextTotalTokensOut = Math.max(0, (prev.totalTokensOut ?? 0) + tokenOutDelta);

    agentProc.agent.usage = {
      ...prev,
      tokensIn: nextTokensIn,
      tokensOut: nextTokensOut,
      estimatedCost: nextEstimatedCost,
      totalTokensSpent: nextTotalTokensIn + nextTotalTokensOut,
      totalTokensIn: nextTotalTokensIn,
      totalTokensOut: nextTotalTokensOut,
    };

    if (agentProc.jsonSchemaPath && typeof event.result === "string" && event.result) {
      try {
        agentProc.agent.structuredResult = JSON.parse(event.result) as Record<string, unknown>;
      } catch {
        // Result is not valid JSON
      }
    }

    saveAgentState(agentProc.agent);
    this.onAgentUpdated(agentProc.agent.id, agentProc.agent, false);
    this.usageTracker.upsertCostTracker(agentProc);

    if (costDelta !== 0) {
      logger.debug(`[usage] result reconciliation: cost adjusted by $${costDelta.toFixed(6)}`, {
        agentId: agentProc.agent.id,
        totalCostUsd,
        sessionEstimate: (agentProc.sessionEstimatedCost ?? 0) - costDelta,
      });
    }
  }

  private batchEvent(event: StreamEvent, agentProc: AgentProcess): void {
    const now = new Date().toISOString();
    agentProc.agent.lastActivity = now;

    if (!event._ts) event._ts = now;
    if (event._idx === undefined) event._idx = agentProc.eventBufferTotal;

    const sanitized = sanitizeEvent(event);
    agentProc.persistBatch += `${JSON.stringify(sanitized)}\n`;

    if (agentProc.eventBuffer.length < EVENT_RING_BUFFER_SIZE) {
      agentProc.eventBuffer.push(sanitized);
    } else {
      agentProc.eventBuffer[agentProc.eventBufferTotal % EVENT_RING_BUFFER_SIZE] = sanitized;
    }
    agentProc.eventBufferTotal++;

    agentProc.listenerBatch.push(event);

    const id = agentProc.agent.id;
    if (!agentProc.persistTimer) {
      agentProc.persistTimer = setTimeout(() => this.flushEventBatch(id, agentProc), 16);
    }
  }
}
