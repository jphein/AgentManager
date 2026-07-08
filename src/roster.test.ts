import { describe, expect, it } from "vitest";
import { isKnownTeammate, parseRoster, rosterStatus, type Teammate } from "./roster";

// Representative `roster.sh --team guildmaster --json` payload — VERIFIED against
// ~/Projects/dreamteam/scripts/roster.sh (2026-07-08, dreamteam#23): key is `agents`
// (not members); statuses lead|active|idle|dead; pid is int-or-null; there is NO
// `mine` field (roster.sh is already team-scoped); it always exits 0 (key off payload).
const SAMPLE = JSON.stringify({
  team: "guildmaster",
  counts: { lead: 1, active: 1, idle: 1, dead: 0 },
  agents: [
    {
      name: "team-lead",
      status: "lead",
      agentId: "a1",
      cwd: "/home/jp/Projects/guildmaster",
      agentType: "lead",
      pid: null,
    },
    {
      name: "nebula-x",
      status: "idle",
      agentId: "a2",
      cwd: "/home/jp/Projects/guildmaster",
      agentType: "nebula",
      pid: 222,
    },
    {
      name: "lucid-y",
      status: "active",
      agentId: "a3",
      cwd: "/home/jp/Projects/guildmaster",
      agentType: "lucid",
      pid: 333,
    },
  ],
});

describe("roster", () => {
  it("parseRoster reads the `agents` array with verified fields", () => {
    const t: Teammate[] = parseRoster(SAMPLE, "guildmaster");
    expect(t.map((m) => m.name).sort()).toEqual(["lucid-y", "nebula-x", "team-lead"]);
    expect(t.find((m) => m.name === "nebula-x")?.status).toBe("idle");
    expect(t.find((m) => m.name === "team-lead")?.pid).toBeNull();
  });

  it("returns [] when team is null (roster.sh exits 0 even with no team — key off payload)", () => {
    expect(parseRoster(JSON.stringify({ team: null, counts: {}, agents: [] }))).toEqual([]);
  });

  it("returns [] on team mismatch (bridge must never target another team)", () => {
    expect(parseRoster(SAMPLE, "some-other-team")).toEqual([]);
  });

  it("tolerates empty / malformed input", () => {
    expect(parseRoster("")).toEqual([]);
    expect(parseRoster("not json")).toEqual([]);
    expect(parseRoster(JSON.stringify({}))).toEqual([]);
  });

  it("isKnownTeammate matches on name (the SendMessage addressable identity)", () => {
    const t = parseRoster(SAMPLE, "guildmaster");
    expect(isKnownTeammate(t, "nebula-x")).toBe(true);
    expect(isKnownTeammate(t, "ghost")).toBe(false);
  });

  it("rosterStatus returns the member status or 'unknown'", () => {
    const t = parseRoster(SAMPLE, "guildmaster");
    expect(rosterStatus(t, "lucid-y")).toBe("active");
    expect(rosterStatus(t, "ghost")).toBe("unknown");
  });
});
