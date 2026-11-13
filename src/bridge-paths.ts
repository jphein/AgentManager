import os from "node:os";
import path from "node:path";

/** Root of the bridge file-queue. Env seam BRIDGE_HOME; defaults to
 *  ~/.guildmaster/bridge so state survives session/terminal loss (R7). */
export function bridgeHome(): string {
  return process.env.BRIDGE_HOME || path.join(process.env.HOME || os.homedir(), ".guildmaster", "bridge");
}

/** Outbound queue: one <msgId>.json handoff per relayed message. */
export function outboundDir(): string {
  return path.join(bridgeHome(), "outbound");
}

/** Ack drop: the dreamteam consumer writes <msgId>.json here after (attempting) delivery. */
export function acksDir(): string {
  return path.join(bridgeHome(), "acks");
}

/** Archive of successfully delivered handoffs. */
export function deliveredDir(): string {
  return path.join(bridgeHome(), "delivered");
}

/** Spawn requests written by the dreamteam-mode spawn stub (Task 4). */
export function spawnRequestsDir(): string {
  return path.join(bridgeHome(), "spawn-requests");
}

/** Shared-context .md files that every agent workspace gets symlinked
 *  (guildmaster#14; was the container path /shared-context). Env seam
 *  SHARED_CONTEXT_DIR (utils/context.ts). A sibling of platform/ and
 *  mcp-tokens/, never their parent: the kill-switch file and tokens must
 *  stay outside the tree agents are handed. */
export function sharedContextDir(): string {
  return path.join(bridgeHome(), "shared-context");
}

/** MCP OAuth tokens, one JSON file per service (guildmaster#14; was the
 *  container path /persistent/mcp-tokens). Env seam MCP_TOKEN_DIR. */
export function mcpTokenDir(): string {
  return path.join(bridgeHome(), "mcp-tokens");
}
