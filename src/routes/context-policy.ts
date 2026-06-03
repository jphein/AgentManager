// Autonomous-context-management policy routes. GET is readable behind normal
// auth (an agent may read the policy it runs under); WRITES are operator-only
// via requireNotAgentService — per ADR-001 the security boundary is the AUTH
// layer: an agent must never edit the policy it is itself subject to.
import express, { type Request, type Response } from "express";
import { requireNotAgentService } from "../auth";
import {
  COOLDOWN_MAX,
  COOLDOWN_MIN,
  type ContextPolicy,
  deleteAgentPolicy,
  getAgentPolicy,
  getEffectiveContextPolicy,
  getGlobalPolicy,
  POLICY_BOUNDS,
  setAgentPolicy,
  setGlobalPolicy,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from "../context-policy-store";
import { logger } from "../logger";
import { errorMessage } from "../types";
import { param } from "../utils/express";

/** Validate a sparse policy patch; throws on invalid input (caller -> 400).
 *  Range-checks here so out-of-range gets a clear 400 rather than a silent clamp. */
function validatePolicyPatch(body: unknown): ContextPolicy {
  if (typeof body !== "object" || body === null) {
    throw new Error("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const patch: ContextPolicy = {};
  const ar = b.autoReset;
  if (ar !== undefined) {
    if (typeof ar !== "object" || ar === null) throw new Error("autoReset must be an object");
    const a = ar as Record<string, unknown>;
    const out: NonNullable<ContextPolicy["autoReset"]> = {};
    if (a.enabled !== undefined) {
      if (typeof a.enabled !== "boolean") throw new Error("autoReset.enabled must be a boolean");
      out.enabled = a.enabled;
    }
    if (a.threshold !== undefined) {
      const v = Number(a.threshold);
      if (!Number.isFinite(v) || v < THRESHOLD_MIN || v > THRESHOLD_MAX) {
        throw new Error(`autoReset.threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}`);
      }
      out.threshold = v;
    }
    if (a.cooldownTurns !== undefined) {
      const v = Number(a.cooldownTurns);
      if (!Number.isInteger(v) || v < COOLDOWN_MIN || v > COOLDOWN_MAX) {
        throw new Error(`autoReset.cooldownTurns must be an integer between ${COOLDOWN_MIN} and ${COOLDOWN_MAX}`);
      }
      out.cooldownTurns = v;
    }
    patch.autoReset = out;
  }
  return patch;
}

export function createContextPolicyRouter() {
  const router = express.Router();

  // ── Global default ─────────────────────────────────────────────────────────

  router.get("/api/context-policy", (_req: Request, res: Response) => {
    res.json({ effective: getEffectiveContextPolicy(), global: getGlobalPolicy(), bounds: POLICY_BOUNDS });
  });

  router.put("/api/context-policy", requireNotAgentService, (req: Request, res: Response) => {
    let patch: ContextPolicy;
    try {
      patch = validatePolicyPatch(req.body);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    setGlobalPolicy(patch)
      .then((saved) => {
        logger.info(`[context-policy] Updated global default: ${JSON.stringify(saved.policy)}`);
        res.json({ effective: getEffectiveContextPolicy(), global: saved, bounds: POLICY_BOUNDS });
      })
      .catch((err: unknown) => {
        logger.warn(`[context-policy] Failed to persist global policy: ${errorMessage(err)}`);
        res.status(500).json({ error: "Failed to save context policy" });
      });
  });

  // ── Per-agent override ──────────────────────────────────────────────────────

  router.get("/api/context-policy/:agentId", (req: Request, res: Response) => {
    const agentId = param(req.params.agentId);
    res.json({
      effective: getEffectiveContextPolicy(agentId),
      global: getGlobalPolicy(),
      agent: getAgentPolicy(agentId),
      bounds: POLICY_BOUNDS,
    });
  });

  router.put("/api/context-policy/:agentId", requireNotAgentService, (req: Request, res: Response) => {
    const agentId = param(req.params.agentId);
    let patch: ContextPolicy;
    try {
      patch = validatePolicyPatch(req.body);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    setAgentPolicy(agentId, patch)
      .then((saved) => {
        logger.info(`[context-policy] Updated override for ${agentId}: ${JSON.stringify(saved.policy)}`);
        res.json({ effective: getEffectiveContextPolicy(agentId), agent: saved, bounds: POLICY_BOUNDS });
      })
      .catch((err: unknown) => {
        logger.warn(`[context-policy] Failed to persist override for ${agentId}: ${errorMessage(err)}`);
        res.status(500).json({ error: "Failed to save context policy" });
      });
  });

  router.delete("/api/context-policy/:agentId", requireNotAgentService, (req: Request, res: Response) => {
    const agentId = param(req.params.agentId);
    deleteAgentPolicy(agentId);
    logger.info(`[context-policy] Cleared override for ${agentId}`);
    res.json({ effective: getEffectiveContextPolicy(agentId), bounds: POLICY_BOUNDS });
  });

  return router;
}
