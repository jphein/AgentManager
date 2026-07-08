import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDreamteamBridge, type SendMessageHandoff } from "./dreamteam-bridge";
import type { AgentMessage } from "./types";

describe("dreamteam-bridge outbound relay + acks", () => {
  let home: string;
  let subscribeCallback: (msg: AgentMessage) => void;
  let bus: {
    subscribe: (cb: (m: AgentMessage) => void) => () => void;
    markRead: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
  const NOW = "2026-07-08T12:00:00.000Z";

  const makeMsg = (over: Partial<AgentMessage>): AgentMessage =>
    ({
      id: "m1",
      from: "sender-agent",
      to: "nebula-x",
      type: "task",
      content: "do the thing",
      createdAt: NOW,
      readBy: [],
      ...over,
    }) as AgentMessage;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "gm-bridge-"));
    subscribeCallback = () => {};
    bus = {
      subscribe: (cb) => {
        subscribeCallback = cb;
        return () => {};
      },
      markRead: vi.fn(),
      post: vi.fn(),
    };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const opts = () => ({
    bridgeHome: home,
    ackTimeoutMs: 1000,
    maxAttempts: 2,
    pollMs: 100,
    now: () => NOW,
  });

  it("writes an outbound handoff for a direct message and does NOT markRead yet", () => {
    attachDreamteamBridge(bus as never, opts());
    subscribeCallback(makeMsg({ id: "m1" }));
    const files = readdirSync(path.join(home, "outbound"));
    expect(files).toContain("m1.json");
    const h = JSON.parse(readFileSync(path.join(home, "outbound", "m1.json"), "utf-8")) as SendMessageHandoff;
    expect(h.to).toBe("nebula-x");
    expect(h.attempt).toBe(1);
    expect(bus.markRead).not.toHaveBeenCalled(); // R16: not read until ack
  });

  it("does not relay status-type or broadcast (no `to`) messages", () => {
    attachDreamteamBridge(bus as never, opts());
    subscribeCallback(makeMsg({ id: "s1", type: "status" }));
    subscribeCallback(makeMsg({ id: "b1", to: undefined }));
    expect(existsSync(path.join(home, "outbound", "s1.json"))).toBe(false);
    expect(existsSync(path.join(home, "outbound", "b1.json"))).toBe(false);
  });

  it("on a 'delivered' ack: markRead is called and handoff moves to delivered/", () => {
    vi.useFakeTimers();
    const stop = attachDreamteamBridge(bus as never, opts());
    subscribeCallback(makeMsg({ id: "m1" }));
    writeFileSync(
      path.join(home, "acks", "m1.json"),
      JSON.stringify({ id: "m1", status: "delivered", deliveredAt: NOW }),
    );
    vi.advanceTimersByTime(100); // one poll tick
    expect(bus.markRead).toHaveBeenCalledWith("m1", "nebula-x");
    expect(existsSync(path.join(home, "outbound", "m1.json"))).toBe(false);
    expect(existsSync(path.join(home, "delivered", "m1.json"))).toBe(true);
    stop();
  });

  it("on ack timeout: re-enqueues up to maxAttempts, then surfaces UNDELIVERED to sender", () => {
    vi.useFakeTimers();
    const stop = attachDreamteamBridge(bus as never, opts());
    subscribeCallback(makeMsg({ id: "m1" }));
    vi.advanceTimersByTime(1000); // attempt 1 times out -> attempt 2 re-enqueued
    const h2 = JSON.parse(readFileSync(path.join(home, "outbound", "m1.json"), "utf-8")) as SendMessageHandoff;
    expect(h2.attempt).toBe(2);
    vi.advanceTimersByTime(1000); // attempt 2 times out -> exhausted
    expect(bus.markRead).not.toHaveBeenCalled();
    expect(bus.post).toHaveBeenCalledWith(
      expect.objectContaining({ to: "sender-agent", type: "info", content: expect.stringContaining("UNDELIVERED") }),
    );
    stop();
  });
});
