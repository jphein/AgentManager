import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapToSpawnRequest, spawnViaDreamteam } from "./dreamteam-spawn";
import type { CreateAgentRequest } from "./types";

describe("dreamteam-spawn (stub)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "gm-spawn-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const spec: CreateAgentRequest = {
    prompt: "research X",
    name: "nebula-r",
    role: "researcher",
    model: "claude-opus-4-6",
    parentId: "lead-1",
  };

  it("mapToSpawnRequest carries name/role/model/prompt/parent into the dreamteam convention", () => {
    const r = mapToSpawnRequest(spec);
    expect(r.name).toBe("nebula-r");
    expect(r.role).toBe("researcher");
    expect(r.model).toBe("claude-opus-4-6");
    expect(r.prompt).toBe("research X");
    expect(r.parentId).toBe("lead-1");
    expect(r.deferred).toBe(true); // stub marker — no live spawn happened
  });

  it("spawnViaDreamteam writes a spawn-request file and NEVER spawns a process", () => {
    const res = spawnViaDreamteam(spec, { bridgeHome: home, now: () => "2026-07-08T12:00:00.000Z" });
    expect(res.deferred).toBe(true);
    const files = readdirSync(path.join(home, "spawn-requests"));
    expect(files.length).toBe(1);
    const written = JSON.parse(readFileSync(path.join(home, "spawn-requests", files[0]), "utf-8"));
    expect(written.name).toBe("nebula-r");
    // Contract: the stub returns a descriptor, not an Agent; no child_process is used.
    expect(res.pid).toBeUndefined();
  });
});
