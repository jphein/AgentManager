import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessageBus } from "../messages";
import type { Teammate } from "../roster";
import { createMessagesRouter } from "./messages";

// Repo idiom (see tokens.test.ts): real express app on an ephemeral port + node:http,
// NOT supertest (which is not a dependency of this project).
function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": String(Buffer.byteLength(payload)) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw } });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let server: http.Server;
let baseUrl: string;
let tmp: string;
// Injected roster the router will see; each test sets it before calling.
let roster: Teammate[] = [];

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      tmp = mkdtempSync(path.join(os.tmpdir(), "gm-msg-"));
      const bus = new MessageBus(path.join(tmp, "messages.jsonl"));
      const app = express();
      app.use(express.json());
      app.use(createMessagesRouter(bus, async () => roster));
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(() => {
  server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("POST /api/messages roster annotation", () => {
  it("adds deliveryWarning for an unknown direct target, still posts", async () => {
    roster = [{ name: "nebula-x", status: "idle" }];
    const { status, body } = await request("POST", `${baseUrl}/api/messages`, {
      from: "u",
      to: "ghost",
      type: "task",
      content: "hi",
    });
    expect(status).toBe(200);
    expect(body.deliveryWarning).toMatch(/not a known owned teammate/);
    expect(body.id).toBeTruthy(); // posted anyway (never blocks)
  });

  it("no warning for a known target", async () => {
    roster = [{ name: "nebula-x", status: "idle" }];
    const { body } = await request("POST", `${baseUrl}/api/messages`, {
      from: "u",
      to: "nebula-x",
      type: "task",
      content: "hi",
    });
    expect(body.deliveryWarning).toBeUndefined();
  });

  it("no warning when the roster is empty (advisory only — never blocks)", async () => {
    roster = [];
    const { body } = await request("POST", `${baseUrl}/api/messages`, {
      from: "u",
      to: "whoever",
      type: "task",
      content: "hi",
    });
    expect(body.deliveryWarning).toBeUndefined();
  });
});
