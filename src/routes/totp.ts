/**
 * TOTP 2FA routes.
 *
 * Uses Node.js built-in crypto only — no external TOTP library dependency.
 * Implements RFC 6238 (TOTP) + RFC 4226 (HOTP) + RFC 4648 (Base32).
 *
 * Routes:
 *   GET  /api/settings/totp/status   – is TOTP enabled?
 *   POST /api/settings/totp/setup    – generate new secret + QR data URL
 *   POST /api/settings/totp/verify   – verify a code and activate TOTP
 *   POST /api/settings/totp/disable  – disable TOTP (requires current code)
 */
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { requireHumanUser } from "../auth";
import { logger } from "../logger";
import { clearTotpSecret, getTotpSecret, setTotpSecret } from "../secrets-store";
import type { AuthenticatedRequest } from "../types";

// ─── RFC 4648 Base32 ─────────────────────────────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str: string): Buffer {
  const s = str.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid Base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ─── RFC 4226 HOTP / RFC 6238 TOTP ──────────────────────────────────────────

function hotp(secret: Buffer, counter: bigint): number {
  const counterBuf = Buffer.allocUnsafe(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return code % 1_000_000;
}

/**
 * Verify a 6-digit TOTP code with a ±1 window (30s period).
 * Returns true if the code matches the current, previous, or next interval.
 */
function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const provided = Number.parseInt(code, 10);
  const secretBuf = base32Decode(secret);
  const t = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (const delta of [-1n, 0n, 1n]) {
    if (hotp(secretBuf, t + delta) === provided) return true;
  }
  return false;
}

function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Build an otpauth:// URI and produce a simple data-URL SVG QR placeholder.
 * In production you'd call a real QR library, but to avoid adding a
 * dependency we return the raw URI for the client to render with qrcode.js
 * or a similar browser-side library.
 */
function buildOtpAuthUri(secret: string, label: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createTotpRouter() {
  const router = express.Router();

  // GET /api/settings/totp/status
  router.get("/api/settings/totp/status", requireHumanUser, (_req: Request, res: Response) => {
    const stored = getTotpSecret();
    res.json({
      enabled: stored !== null,
      enabledAt: stored?.enabledAt ?? null,
    });
  });

  // POST /api/settings/totp/setup
  // Generates a new TOTP secret and returns the otpauth URI.
  // The secret is NOT saved until /verify is called.
  router.post("/api/settings/totp/setup", requireHumanUser, (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const secret = generateSecret();
    const issuer = "AgentManager";
    const label = user?.sub ?? "user";
    const uri = buildOtpAuthUri(secret, label, issuer);
    logger.info("[totp] Setup initiated", { sub: label });
    res.json({ secret, uri });
  });

  // POST /api/settings/totp/verify
  // Body: { secret: string; code: string }
  // Activates TOTP if the code is correct for the given secret.
  router.post("/api/settings/totp/verify", requireHumanUser, (req: Request, res: Response) => {
    const { secret, code } = (req.body ?? {}) as { secret?: string; code?: string };
    if (!secret || typeof secret !== "string") {
      res.status(400).json({ error: "secret is required" });
      return;
    }
    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "code is required" });
      return;
    }
    if (!verifyTotp(secret, code)) {
      res.status(400).json({ error: "Invalid code — check your authenticator app and try again" });
      return;
    }
    try {
      setTotpSecret(secret);
    } catch (err: unknown) {
      logger.error("[totp] Failed to save TOTP secret", { error: String(err) });
      res.status(500).json({ error: "Failed to save TOTP configuration" });
      return;
    }
    logger.warn("[AUDIT] TOTP 2FA enabled");
    res.json({ ok: true, enabledAt: new Date().toISOString() });
  });

  // POST /api/settings/totp/disable
  // Body: { code: string }
  // Requires a valid current TOTP code to disable.
  router.post("/api/settings/totp/disable", requireHumanUser, (req: Request, res: Response) => {
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "code is required" });
      return;
    }
    const stored = getTotpSecret();
    if (!stored) {
      res.status(400).json({ error: "TOTP is not enabled" });
      return;
    }
    if (!verifyTotp(stored.secret, code)) {
      res.status(400).json({ error: "Invalid code" });
      return;
    }
    clearTotpSecret();
    logger.warn("[AUDIT] TOTP 2FA disabled");
    res.json({ ok: true });
  });

  return router;
}
