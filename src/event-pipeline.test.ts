import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { EventPipeline } from "./event-pipeline";
import type { AgentProcess, StreamEvent } from "./types";

// ─── Minimal stubs ────────────────────────────────────────────────────────────

function makeAgentProc(id = "agent-1"): AgentProcess {
  return {
    agent: {
      id,
      name: "test-agent",
      model: "claude-sonnet-4-6",
      status: "running",
      createdAt: new Date().toISOString(),
      usage: {
        tokensIn: 0,
        tokensOut: 0,
        estimatedCost: 0,
        totalTokensSpent: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        apiTurns: 0,
        lastTurnTokensIn: 0,
      },
    },
    listeners: new Set(),
    eventBuffer: [],
    eventBufferTotal: 0,
    persistBatch: "",
    persistTimer: null,
    listenerBatch: [],
    seenMessageIds: new Set(),
    sessionEstimatedCost: 0,
    sessionTokensIn: 0,
    sessionTokensOut: 0,
    softStallNotified: false,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

function makeRegistry(proc: AgentProcess) {
  return { get: (id: string) => (id === proc.agent.id ? proc : undefined) };
}

function makeUsageTracker() {
  return { upsertCostTracker: vi.fn() };
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("./persistence", () => ({
  EVENTS_DIR: "/tmp/__ep_test_events",
  saveAgentState: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(""),
  rename: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  createReadStream: vi.fn().mockReturnValue({ pipe: vi.fn() }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EventPipeline", () => {
  let agentProc: AgentProcess;
  let registry: ReturnType<typeof makeRegistry>;
  let usageTracker: ReturnType<typeof makeUsageTracker>;
  let writeQueues: Map<string, Promise<void>>;
  let onAgentUpdated: MockInstance;
  let pipeline: EventPipeline;

  beforeEach(() => {
    vi.useFakeTimers();
    agentProc = makeAgentProc();
    registry = makeRegistry(agentProc);
    usageTracker = makeUsageTracker();
    writeQueues = new Map();
    onAgentUpdated = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    pipeline = new EventPipeline(registry as any, usageTracker as any, writeQueues, onAgentUpdated as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("handleEvent — unknown agent", () => {
    it("is a no-op for unknown agent id", () => {
      const event: StreamEvent = { type: "assistant", subtype: "text" } as StreamEvent;
      expect(() => pipeline.handleEvent("no-such-id", event)).not.toThrow();
    });
  });

  describe("handleEvent — init system event", () => {
    it("updates claudeSessionId and actualModel from init event", async () => {
      const { saveAgentState } = await import("./persistence");
      const event = {
        type: "system",
        subtype: "init",
        session_id: "sess-123",
        model: "claude-sonnet-4-6",
        tools: ["Bash"],
      } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.agent.claudeSessionId).toBe("sess-123");
      expect(agentProc.agent.actualModel).toBe("claude-sonnet-4-6");
      expect(agentProc.agent.activeTools).toEqual(["Bash"]);
      expect(saveAgentState).toHaveBeenCalledWith(agentProc.agent);
      expect(onAgentUpdated).toHaveBeenCalledWith("agent-1", agentProc.agent, true);
    });
  });

  describe("handleEvent — stream_event (transient)", () => {
    it("does not add stream_event to persistBatch", () => {
      const event: StreamEvent = { type: "stream_event", subtype: "text" } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.persistBatch).toBe("");
    });

    it("adds stream_event to listenerBatch", () => {
      const event: StreamEvent = { type: "stream_event", subtype: "text" } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.listenerBatch).toContain(event);
    });

    it("schedules flush timer for stream_event", () => {
      const event: StreamEvent = { type: "stream_event", subtype: "text" } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.persistTimer).not.toBeNull();
    });
  });

  describe("handleEvent — assistant event with usage", () => {
    it("accumulates token counts for new message IDs", () => {
      const event = {
        type: "assistant",
        subtype: "text",
        message: {
          id: "msg-001",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.agent.usage?.tokensIn).toBe(100);
      expect(agentProc.agent.usage?.tokensOut).toBe(50);
      expect(agentProc.agent.usage?.apiTurns).toBe(1);
      expect(usageTracker.upsertCostTracker).toHaveBeenCalledWith(agentProc);
    });

    it("deduplicates by message ID — second call with same ID is ignored", () => {
      const event = {
        type: "assistant",
        subtype: "text",
        message: {
          id: "msg-002",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      pipeline.handleEvent("agent-1", event); // duplicate
      expect(agentProc.agent.usage?.apiTurns).toBe(1); // counted once
    });

    it("resets stall status on assistant output", async () => {
      const { saveAgentState } = await import("./persistence");
      agentProc.agent.status = "stalled";
      agentProc.stallCount = 5;
      const event = {
        type: "assistant",
        subtype: "text",
        message: { id: "msg-003", usage: { input_tokens: 1, output_tokens: 1 } },
      } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.agent.status).toBe("running");
      expect(agentProc.stallCount).toBe(0);
      expect(saveAgentState).toHaveBeenCalled();
    });
  });

  describe("readEventBuffer", () => {
    it("returns empty array when no events", () => {
      expect(pipeline.readEventBuffer(agentProc)).toEqual([]);
    });

    it("returns events in insertion order before wrap", () => {
      const e1 = { type: "assistant", _idx: 0 } as StreamEvent;
      const e2 = { type: "result", _idx: 1 } as StreamEvent;
      agentProc.eventBuffer = [e1, e2];
      agentProc.eventBufferTotal = 2;
      expect(pipeline.readEventBuffer(agentProc)).toEqual([e1, e2]);
    });
  });

  describe("readPersistedEvents", () => {
    it("returns empty when no file exists and no in-memory buffer", async () => {
      const result = await pipeline.readPersistedEvents("agent-1");
      expect(result.events).toEqual([]);
      expect(result.baseIndex).toBe(0);
    });

    it("returns in-memory buffer when events exist", async () => {
      const e = { type: "assistant", _idx: 0 } as StreamEvent;
      agentProc.eventBuffer = [e];
      agentProc.eventBufferTotal = 1;
      const result = await pipeline.readPersistedEvents("agent-1");
      expect(result.events).toContain(e);
      expect(result.baseIndex).toBe(0);
    });
  });

  describe("flushEventBatch", () => {
    it("clears persistTimer and persistBatch and enqueues an appendFile write", async () => {
      agentProc.persistBatch = '{"type":"result"}\n';
      agentProc.persistTimer = setTimeout(() => {}, 1000);
      pipeline.flushEventBatch("agent-1", agentProc);
      // Synchronous effects happen immediately
      expect(agentProc.persistBatch).toBe("");
      expect(agentProc.persistTimer).toBeNull();
      // A write was queued into the writeQueues map
      const pendingWrite = writeQueues.get("agent-1");
      expect(pendingWrite).toBeDefined();
      // Resolve it and verify appendFile was called
      const { appendFile } = await import("node:fs/promises");
      await pendingWrite;
      expect(appendFile).toHaveBeenCalled();
    });

    it("notifies listeners with buffered events", () => {
      const listener = vi.fn();
      agentProc.listeners.add(listener);
      const event = { type: "result" } as StreamEvent;
      agentProc.listenerBatch = [event];
      pipeline.flushEventBatch("agent-1", agentProc);
      expect(listener).toHaveBeenCalledWith(event);
      expect(agentProc.listenerBatch).toEqual([]);
    });
  });

  describe("batchEvent via handleEvent", () => {
    it("adds non-stream events to persistBatch and eventBuffer", () => {
      const event = { type: "result", subtype: "success", total_cost_usd: 0.001 } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.persistBatch).toContain('"type":"result"');
      expect(agentProc.eventBuffer.length).toBe(1);
      expect(agentProc.eventBufferTotal).toBe(1);
    });

    it("sets persistTimer when batching", () => {
      const event = { type: "result" } as StreamEvent;
      pipeline.handleEvent("agent-1", event);
      expect(agentProc.persistTimer).not.toBeNull();
    });
  });
});
