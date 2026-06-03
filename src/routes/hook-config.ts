// Operator-only trusted configuration. These routes accept arbitrary hook rules
// including type:'command' entries that get injected into agent settings.json and
// executed by the CLI. Input is validated strictly; command strings are checked
// against DANGEROUS_BASH_PATTERNS. This endpoint must remain behind auth middleware.
import express from "express";
import { getHookConfig, type HookEvent, type HookRule, type HookType, setHookConfig } from "../hook-config-store";
import { logger } from "../logger";
import { param } from "../utils/express";
import { checkDangerousCommand } from "./hooks"; // exported in step 4a

const VALID_EVENTS = new Set<HookEvent>(["PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop"]);
const VALID_TYPES = new Set<HookType>(["http", "command"]);
const MAX_RULES = 20;
const MAX_TIMEOUT_MS = 60_000;

function validateRules(rules: unknown[]): HookRule[] {
  // Throws with a descriptive message if invalid
  if (!Array.isArray(rules)) throw new Error("rules must be an array");
  if (rules.length > MAX_RULES) throw new Error(`max ${MAX_RULES} rules per agent`);
  return rules.map((r, i) => {
    if (typeof r !== "object" || r === null) throw new Error(`rule[${i}]: must be an object`);
    const rule = r as Record<string, unknown>;
    if (!VALID_EVENTS.has(rule.event as HookEvent)) throw new Error(`rule[${i}]: invalid event "${rule.event}"`);
    if (!VALID_TYPES.has(rule.type as HookType)) throw new Error(`rule[${i}]: invalid type "${rule.type}"`);
    if (rule.type === "http") {
      if (typeof rule.url !== "string" || !rule.url) throw new Error(`rule[${i}]: url required for type http`);
      if (rule.command !== undefined) throw new Error(`rule[${i}]: command must not be set when type is http`);
    } else {
      if (typeof rule.command !== "string" || !rule.command)
        throw new Error(`rule[${i}]: command required for type command`);
      if (rule.url !== undefined) throw new Error(`rule[${i}]: url must not be set when type is command`);
      const danger = checkDangerousCommand(rule.command);
      if (danger) throw new Error(`rule[${i}]: command rejected — ${danger}`);
    }
    if (rule.timeout !== undefined) {
      if (typeof rule.timeout !== "number" || rule.timeout < 1 || rule.timeout > MAX_TIMEOUT_MS)
        throw new Error(`rule[${i}]: timeout must be 1–${MAX_TIMEOUT_MS}ms`);
    }
    if (rule.matcher !== undefined && typeof rule.matcher !== "string")
      throw new Error(`rule[${i}]: matcher must be a string`);
    // Validate matcher as a valid regex
    if (typeof rule.matcher === "string") {
      try {
        new RegExp(rule.matcher);
      } catch {
        throw new Error(`rule[${i}]: matcher is not a valid regex`);
      }
    }
    return {
      id: typeof rule.id === "string" && rule.id ? rule.id : crypto.randomUUID(),
      event: rule.event as HookEvent,
      type: rule.type as HookType,
      ...(rule.matcher !== undefined && { matcher: rule.matcher as string }),
      ...(rule.url !== undefined && { url: rule.url as string }),
      ...(rule.command !== undefined && { command: rule.command as string }),
      ...(rule.timeout !== undefined && { timeout: rule.timeout as number }),
      ...(rule.async !== undefined && { async: Boolean(rule.async) }),
    };
  });
}

const router = express.Router();

router.get("/:id/hooks", (req, res) => {
  const agentId = param(req.params.id);
  const config = getHookConfig(agentId);
  res.json({ rules: config.rules });
});

router.put("/:id/hooks", (req, res) => {
  const agentId = param(req.params.id);
  try {
    const rules = validateRules(req.body?.rules ?? []);
    setHookConfig(agentId, rules)
      .then((saved) => {
        logger.info(`[hook-config] Updated ${rules.length} rules for agent ${agentId}`);
        res.json({ rules: saved.rules });
      })
      .catch((err: unknown) => {
        logger.warn("[hook-config] Failed to persist hook rules", { agentId, error: err });
        res.status(500).json({ error: "Failed to save hook config" });
      });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

export default router;
