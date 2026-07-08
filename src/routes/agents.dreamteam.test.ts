import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentsRouter } from "./agents";

// Repo idiom (tokens.test.ts): real express app + node:http, NOT supertest (not a dep).
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
const OLD_MODE = process.env.BRIDGE_SPAWN_MODE;
const OLD_HOME = process.env.BRIDGE_HOME;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      // Fake manager whose create() throws — proves the dreamteam branch returns 202
      // WITHOUT ever calling agentManager.create (no spawn path reached).
      const fakeManager = {
        create: () => {
          throw new Error("create() must NOT be called in dreamteam mode");
        },
        list: () => [],
      };
      const app = express();
      app.use(express.json());
      app.use(
        createAgentsRouter(
          fakeManager as never,
          {} as never,
          () => {},
          () => {},
          () => false,
        ),
      );
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(() => server?.close());

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "gm-spawn-route-"));
  process.env.BRIDGE_SPAWN_MODE = "dreamteam";
  process.env.BRIDGE_HOME = tmp;
});
afterEach(() => {
  if (OLD_MODE === undefined) delete process.env.BRIDGE_SPAWN_MODE;
  else process.env.BRIDGE_SPAWN_MODE = OLD_MODE;
  if (OLD_HOME === undefined) delete process.env.BRIDGE_HOME;
  else process.env.BRIDGE_HOME = OLD_HOME;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("POST /api/agents dreamteam mode", () => {
  it("returns 202 deferred and never calls agentManager.create", async () => {
    const { status, body } = await request("POST", `${baseUrl}/api/agents`, {
      prompt: "hi there",
      name: "n1",
      model: "claude-haiku-4-5-20251001",
    });
    expect(status).toBe(202);
    expect(body.deferred).toBe(true);
    expect((body.spawnRequest as { name: string }).name).toBe("n1");
  });
});
