# Dreamteam bridge — file-queue handoff & delivery-ack contract

Self-contained spec for the **queue consumer**, which is NOT built in the AgentManager
fork (only a live Claude Code session can call native `SendMessage`). The consumer is a
separate **guildmaster-side** process. This document is implementable without reading any
other file.

The AgentManager side (the **producer**, `src/dreamteam-bridge.ts`) owns the file lifecycle,
retries, delivery-acks, `bus.markRead`, and the UNDELIVERED surfacing. The consumer's *only*
delivery-ack duty is: drain outbound handoffs, call `SendMessage`, and **write an ack for
every handoff it drains**.

## Directories (under `$BRIDGE_HOME`, default `~/.guildmaster/bridge`)
- `outbound/<msgId>.json` — one handoff per relayed message (producer-written).
- `acks/<msgId>.json` — one ack per handoff (**consumer-written**).
- `delivered/<msgId>.json` — archive of delivered handoffs (producer-moved).

## Outbound handoff — `outbound/<msgId>.json` (producer → consumer)
```json
{
  "id": "<msgId>",
  "to": "<teammate name — the SendMessage addressable identity>",
  "from": "<sender agentId>",
  "fromName": "<sender label, optional>",
  "type": "task|result|question|info|interrupt",
  "content": "<message body>",
  "metadata": { "...": "opaque, optional" },
  "enqueuedAt": "<ISO-8601>",
  "attempt": 1
}
```
`status`-type messages and broadcasts (no `to`) are **never** relayed (matches the native
`attachMessageDelivery` behaviour).

## Ack — `acks/<msgId>.json` (consumer → producer)
```json
{ "id": "<msgId>", "status": "delivered|failed", "deliveredAt": "<ISO-8601>", "detail": "<optional>" }
```

## Consumer loop (guildmaster-side, in a live Claude Code session)
1. Poll `outbound/` for `*.json` handoffs.
2. For each, call native `SendMessage(to, content)` (+ summary/metadata as available).
3. Write `acks/<id>.json`:
   - `{"status":"delivered"}` on success.
   - `{"status":"failed","detail":"..."}` when `SendMessage` can't reach the teammate
     (unknown/dead in roster).
4. **MUST write an ack for every handoff drained.** A missing ack is not an error — it only
   falls through to the producer's slower timeout path — but an explicit ack is far faster
   and cleaner.
5. **Do NOT delete or move `outbound/<id>.json`.** The producer owns file lifecycle: it
   archives the handoff to `delivered/` on a delivered-ack. If the consumer deletes it, the
   `delivered/` archive is lost.

## Ack semantics (R16 + R12/R13) — all in the PRODUCER
- **delivered** → producer calls `bus.markRead(msgId, to)`, moves the handoff to `delivered/`,
  clears its ledger entry. `markRead` fires **only on confirmed delivery** (fixes the
  optimistic-ack bug where the native path marked read before delivery was confirmed).
- **failed OR no ack within `ackTimeoutMs`** → producer increments `attempt`; if
  `attempt <= maxAttempts` it re-enqueues (rewrites `outbound/<id>.json`); else it posts a
  **surfacing** message back to the sender
  (`bus.post({from:"bridge", to:<sender>, type:"info", content:"UNDELIVERED …"})`) and stops.
- **"undelivered" ≠ "agent dead" (R12).** The producer never infers death from a missing ack;
  it only reports the delivery outcome. Diagnosing stalled-vs-dead is the **watchtower's**
  job — the UNDELIVERED message points the operator at `gm peek <teammate>` (R13). A missing
  ack is a delivery signal, not a liveness signal.
