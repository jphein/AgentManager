/**
 * Dreamteam bridge — outbound relay from MessageBus to native SendMessage via an
 * explicit FILE-QUEUE handoff (never a direct harness call). Implements R16
 * delivery-acks: a message is not marked read until the dreamteam-side consumer
 * writes a 'delivered' ack; unacked-past-timeout is retried (bounded) then
 * surfaced to the sender — never silently dropped. A missing ack is NOT treated
 * as agent-death (R12) — diagnosis is the watchtower's job (R13, `gm peek`).
 *
 * See docs/dreamteam-bridge-contract.md for the consumer contract.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import type { MessageBus } from "./messages";
import { errorMessage } from "./types";

export interface SendMessageHandoff {
  id: string;
  to: string;
  from: string;
  fromName?: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  enqueuedAt: string;
  attempt: number;
}

export interface DeliveryAck {
  id: string;
  status: "delivered" | "failed";
  deliveredAt?: string;
  detail?: string;
}

export interface BridgeOptions {
  bridgeHome: string;
  ackTimeoutMs: number;
  maxAttempts: number;
  pollMs: number;
  now?: () => string;
}

interface Pending {
  handoff: SendMessageHandoff;
  deadline: number; // ms epoch (uses tick counter under fake timers)
}

/** Attach the relay. Returns a stop() that unsubscribes and clears the poll. */
export function attachDreamteamBridge(bus: MessageBus, opts: BridgeOptions): () => void {
  const now = opts.now ?? (() => new Date().toISOString());
  const outbound = path.join(opts.bridgeHome, "outbound");
  const acks = path.join(opts.bridgeHome, "acks");
  const delivered = path.join(opts.bridgeHome, "delivered");
  for (const d of [outbound, acks, delivered]) mkdirSync(d, { recursive: true });

  const pending = new Map<string, Pending>();
  let elapsed = 0; // ms; incremented per poll tick so behaviour is deterministic under fake timers

  const writeHandoff = (h: SendMessageHandoff): void => {
    const tmp = path.join(outbound, `.${h.id}.tmp`);
    writeFileSync(tmp, JSON.stringify(h), "utf-8");
    renameSync(tmp, path.join(outbound, `${h.id}.json`));
  };

  const enqueue = (h: SendMessageHandoff): void => {
    writeHandoff(h);
    pending.set(h.id, { handoff: h, deadline: elapsed + opts.ackTimeoutMs });
  };

  const unsubscribe = bus.subscribe((msg) => {
    if (!msg.to) return; // broadcasts are not point-to-point relays
    if (msg.type === "status") return; // matches attachMessageDelivery
    const handoff: SendMessageHandoff = {
      id: msg.id,
      to: msg.to,
      from: msg.from,
      fromName: msg.fromName,
      type: msg.type,
      content: msg.content,
      metadata: msg.metadata,
      enqueuedAt: now(),
      attempt: 1,
    };
    try {
      enqueue(handoff);
    } catch (err: unknown) {
      logger.warn("[bridge] failed to enqueue handoff", { id: msg.id, error: errorMessage(err) });
    }
  });

  const readAck = (id: string): DeliveryAck | null => {
    const p = path.join(acks, `${id}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as DeliveryAck;
    } catch {
      return null;
    }
  };

  const clearFiles = (id: string, archive: boolean): void => {
    const ob = path.join(outbound, `${id}.json`);
    if (archive && existsSync(ob)) renameSync(ob, path.join(delivered, `${id}.json`));
    else if (existsSync(ob)) rmSync(ob, { force: true });
    const ap = path.join(acks, `${id}.json`);
    if (existsSync(ap)) rmSync(ap, { force: true });
  };

  const tick = (): void => {
    elapsed += opts.pollMs;
    for (const [id, entry] of pending) {
      const ack = readAck(id);
      if (ack?.status === "delivered") {
        bus.markRead(id, entry.handoff.to); // R16: read ONLY on confirmed delivery
        clearFiles(id, true);
        pending.delete(id);
        continue;
      }
      const failed = ack?.status === "failed";
      if (failed || elapsed >= entry.deadline) {
        if (entry.handoff.attempt < opts.maxAttempts) {
          const retry: SendMessageHandoff = {
            ...entry.handoff,
            attempt: entry.handoff.attempt + 1,
            enqueuedAt: now(),
          };
          if (existsSync(path.join(acks, `${id}.json`))) rmSync(path.join(acks, `${id}.json`), { force: true });
          enqueue(retry);
        } else {
          // exhausted — surface to sender, never silently drop (R16)
          bus.post({
            from: "bridge",
            to: entry.handoff.from,
            type: "info",
            content: `UNDELIVERED: message ${id} to '${entry.handoff.to}' after ${opts.maxAttempts} attempt(s)${ack?.detail ? ` (${ack.detail})` : ""}. Not a death signal — run 'gm peek ${entry.handoff.to}' to diagnose.`,
          });
          clearFiles(id, false);
          pending.delete(id);
        }
      }
    }
  };

  const timer = setInterval(tick, opts.pollMs);
  (timer as { unref?: () => void }).unref?.();

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
