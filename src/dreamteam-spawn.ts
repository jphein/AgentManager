/**
 * Dreamteam-convention spawn STUB. Maps AgentManager's CreateAgentRequest to a
 * dreamteam spawn descriptor and drops it as a spawn-request file. It DOES NOT
 * launch a process — turning a request into a live, gate-honoring teammate is
 * dreamteam's job and is verified only under Task 5 (needs-JP live test).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CreateAgentRequest } from "./types";

export interface DreamteamSpawnRequest {
  name: string;
  role?: string;
  model?: string;
  prompt: string;
  parentId?: string;
  /** Always true for the stub — signals "no live process was created". */
  deferred: true;
}

/** Pure mapping — no I/O. (Note: this repo's CreateAgentRequest has no `effort`
 *  field, so none is carried — unlike the plan's draft written against a different shape.) */
export function mapToSpawnRequest(spec: CreateAgentRequest): DreamteamSpawnRequest {
  return {
    name: spec.name ?? "agent",
    role: spec.role,
    model: spec.model,
    prompt: spec.prompt,
    parentId: spec.parentId,
    deferred: true,
  };
}

export interface SpawnStubResult extends DreamteamSpawnRequest {
  requestId: string;
  /** Never set by the stub — present in the type only so the live impl can add it. */
  pid?: number;
}

/** Write a spawn-request file the dreamteam consumer will later action. Returns a
 *  descriptor. NEVER spawns a process (verified by dreamteam-spawn.test.ts). */
export function spawnViaDreamteam(
  spec: CreateAgentRequest,
  opts: { bridgeHome: string; now?: () => string },
): SpawnStubResult {
  const dir = path.join(opts.bridgeHome, "spawn-requests");
  mkdirSync(dir, { recursive: true });
  const req = mapToSpawnRequest(spec);
  const requestId = `${req.name}-${(opts.now?.() ?? new Date().toISOString()).replace(/[:.]/g, "-")}`;
  const tmp = path.join(dir, `.${requestId}.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...req, requestId }, null, 2), "utf-8");
  renameSync(tmp, path.join(dir, `${requestId}.json`));
  return { ...req, requestId };
}
