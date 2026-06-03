import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";

// Autonomous-context-management policy store. Mirrors hook-config-store.ts
// (JSON-per-key under /persistent), but adds a GLOBAL DEFAULT plus optional
// PER-AGENT OVERRIDES: effective = merge(builtin, global, perAgent).
//
// The shape is NESTED BY CONCERN so each feature owns a sub-object. The only
// concern wired today is `autoReset` (consumed by src/context-autoreset.ts,
// 1e). Adding a future concern is additive: add its sub-object to the
// interfaces + sanitize()/merge(); no structural change.
//
// IMPORTANT: `autoReset.threshold` is a FRACTION (0..1), NOT a percentage —
// this matches the live consumer (context-autoreset.ts reads .autoReset and
// multiplies by 100 for display). Do not switch units without updating 1e.

/** Per-concern auto-reset tuning. All fields optional in a stored override. */
export interface AutoResetPolicy {
  enabled?: boolean; // master toggle (effective default: true)
  threshold?: number; // band ceiling as a fraction 0..1 (effective default: 0.72)
  cooldownTurns?: number; // onIdle turns to wait after a reset (effective default: 3)
}

/** Sparse override — carries only the fields it changes. */
export interface ContextPolicy {
  autoReset?: AutoResetPolicy;
}

/** Fully-resolved auto-reset config — no optional fields. */
export interface EffectiveAutoReset {
  enabled: boolean;
  threshold: number;
  cooldownTurns: number;
}

/** Fully-resolved policy returned by the resolver. */
export interface EffectiveContextPolicy {
  autoReset: EffectiveAutoReset;
}

/** Stored shape for one key: scope is "default" (global) or an agentId. */
export interface ContextPolicyRecord {
  scope: string;
  policy: ContextPolicy;
  updatedAt: string; // ISO timestamp ("" when never written)
}

// ─── Guard-rail bounds + built-in defaults ───────────────────────────────────

export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.9;
export const THRESHOLD_DEFAULT = 0.72;
export const COOLDOWN_MIN = 1;
export const COOLDOWN_MAX = 50;
export const COOLDOWN_DEFAULT = 3;

/** Built-in default — in force before any operator customization. `enabled`
 *  defaults true to match the context-autoreset fallback (headline behaviour). */
export const BUILTIN_DEFAULT: EffectiveContextPolicy = {
  autoReset: { enabled: true, threshold: THRESHOLD_DEFAULT, cooldownTurns: COOLDOWN_DEFAULT },
};

/** Machine-readable bounds for clients (UI sliders, validation). */
export const POLICY_BOUNDS = {
  autoReset: {
    threshold: { min: THRESHOLD_MIN, max: THRESHOLD_MAX },
    cooldownTurns: { min: COOLDOWN_MIN, max: COOLDOWN_MAX },
  },
};

export const GLOBAL_SCOPE = "default"; // reserved scope key for the global record

// ─── Persistence ─────────────────────────────────────────────────────────────

const PERSISTENT_BASE = "/persistent";
const PERSISTENT_AVAILABLE = existsSync(PERSISTENT_BASE);
const CONTEXT_POLICY_DIR = PERSISTENT_AVAILABLE ? `${PERSISTENT_BASE}/context-policies` : "/tmp/context-policies";

mkdirSync(CONTEXT_POLICY_DIR, { recursive: true });

function policyPath(scope: string): string {
  return path.join(CONTEXT_POLICY_DIR, `${scope}.json`);
}

function readRecord(scope: string): ContextPolicyRecord {
  const filePath = policyPath(scope);
  if (!existsSync(filePath)) return { scope, policy: {}, updatedAt: "" };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as ContextPolicyRecord;
    return { scope, policy: sanitize(parsed.policy ?? {}), updatedAt: parsed.updatedAt ?? "" };
  } catch (err: unknown) {
    logger.warn(
      `[context-policy-store] Failed to read policy for ${scope}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { scope, policy: {}, updatedAt: "" };
  }
}

async function writeRecord(scope: string, policy: ContextPolicy): Promise<ContextPolicyRecord> {
  const record: ContextPolicyRecord = { scope, policy: sanitize(policy), updatedAt: new Date().toISOString() };
  const filePath = policyPath(scope);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(record), "utf-8");
  await rename(tmpPath, filePath);
  return record;
}

// ─── Clamp / merge helpers ───────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Drop unknown/invalid fields and clamp numbers. Never throws — an invalid
 *  value is omitted (so the field inherits) rather than rejected. */
function sanitize(policy: ContextPolicy): ContextPolicy {
  const out: ContextPolicy = {};
  const ar = policy.autoReset;
  if (ar && typeof ar === "object") {
    const clean: AutoResetPolicy = {};
    if (typeof ar.enabled === "boolean") clean.enabled = ar.enabled;
    if (typeof ar.threshold === "number" && Number.isFinite(ar.threshold)) {
      clean.threshold = clamp(ar.threshold, THRESHOLD_MIN, THRESHOLD_MAX);
    }
    if (typeof ar.cooldownTurns === "number" && Number.isFinite(ar.cooldownTurns)) {
      clean.cooldownTurns = clamp(Math.round(ar.cooldownTurns), COOLDOWN_MIN, COOLDOWN_MAX);
    }
    if (Object.keys(clean).length > 0) out.autoReset = clean;
  }
  return out;
}

/** Layer sparse overrides over a complete base; later args win per-field. */
function merge(base: EffectiveContextPolicy, ...layers: ContextPolicy[]): EffectiveContextPolicy {
  const out: EffectiveContextPolicy = { autoReset: { ...base.autoReset } };
  for (const layer of layers) {
    const ar = sanitize(layer).autoReset;
    if (ar?.enabled !== undefined) out.autoReset.enabled = ar.enabled;
    if (ar?.threshold !== undefined) out.autoReset.threshold = ar.threshold;
    if (ar?.cooldownTurns !== undefined) out.autoReset.cooldownTurns = ar.cooldownTurns;
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────
// get* return the raw sparse record ("" updatedAt if never set). set* clamp +
// sanitize before persisting. Deleting an override reverts the agent to global.

export function getGlobalPolicy(): ContextPolicyRecord {
  return readRecord(GLOBAL_SCOPE);
}

export function getAgentPolicy(agentId: string): ContextPolicyRecord {
  return readRecord(agentId);
}

export function setGlobalPolicy(policy: ContextPolicy): Promise<ContextPolicyRecord> {
  return writeRecord(GLOBAL_SCOPE, policy);
}

export function setAgentPolicy(agentId: string, policy: ContextPolicy): Promise<ContextPolicyRecord> {
  return writeRecord(agentId, policy);
}

export function deleteAgentPolicy(agentId: string): void {
  const filePath = policyPath(agentId);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/**
 * Resolve the effective policy: BUILTIN_DEFAULT <- global <- per-agent override.
 * Sync + fail-safe (read errors yield builtin defaults, never throws) so the
 * context-autoreset hot path  can call it inline. 1e calls it with
 * no agentId, which yields the global effective policy; passing an agentId
 * layers that agent's override on top.
 */
export function getEffectiveContextPolicy(agentId?: string): EffectiveContextPolicy {
  const layers: ContextPolicy[] = [getGlobalPolicy().policy];
  if (agentId && agentId !== GLOBAL_SCOPE) layers.push(getAgentPolicy(agentId).policy);
  return merge(BUILTIN_DEFAULT, ...layers);
}
