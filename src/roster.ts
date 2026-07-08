import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger";
import { errorMessage } from "./types";

const execFileAsync = promisify(execFile);

export type RosterStatus = "lead" | "active" | "idle" | "dead" | "unknown";

export interface Teammate {
  name: string; // dreamteam addressable name == SendMessage(to:)
  status: RosterStatus;
  agentId?: string;
  cwd?: string;
  agentType?: string;
  pid?: number | null; // int when active/idle; null for lead/dead
}

/** Parse `roster.sh --team <T> --json` output:
 *    {team, counts:{lead,active,idle,dead}, agents:[{name,status,agentId,cwd,agentType,pid}]}
 *  Verified against ~/Projects/dreamteam/scripts/roster.sh (dreamteam#23). Tolerant: bad input → [].
 *  roster.sh ALWAYS exits 0 (even with no team) — we key off the payload, not the exit code:
 *  a null `team` → []. There is NO `mine` field; roster.sh is already team-scoped, so as a guard
 *  against a BRIDGE_TEAM misconfig, if `expectTeam` is given and the payload team differs → [].
 *  (fleet.sh, the cross-project observer, is never used as a dispatch registry — R5/R8.) */
export function parseRoster(raw: string, expectTeam?: string): Teammate[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const d = doc as { team?: unknown; agents?: unknown };
  const team = typeof d?.team === "string" ? d.team : null;
  if (!team) return []; // no team resolved (roster.sh still exited 0)
  if (expectTeam && team !== expectTeam) {
    logger.warn("[roster] team mismatch; refusing to treat as registry", { got: team, expected: expectTeam });
    return [];
  }
  const agents = d?.agents;
  if (!Array.isArray(agents)) return [];
  const VALID = new Set(["lead", "active", "idle", "dead"]);
  return agents
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      name: String(a.name ?? ""),
      status: (VALID.has(String(a.status)) ? String(a.status) : "unknown") as RosterStatus,
      agentId: a.agentId == null ? undefined : String(a.agentId),
      cwd: a.cwd == null ? undefined : String(a.cwd),
      agentType: a.agentType == null ? undefined : String(a.agentType),
      pid: typeof a.pid === "number" ? a.pid : null,
    }))
    .filter((a) => a.name.length > 0);
}

export function isKnownTeammate(roster: Teammate[], name: string): boolean {
  return roster.some((m) => m.name === name);
}

export function rosterStatus(roster: Teammate[], name: string): RosterStatus {
  return roster.find((m) => m.name === name)?.status ?? "unknown";
}

/** Load the live roster by shelling GUILDMASTER_ROSTER_CMD (default `roster.sh`) with
 *  `--team <BRIDGE_TEAM> --json`. Returns [] on any failure or team mismatch (roster is
 *  advisory, never a hard gate). BRIDGE_TEAM is required for a non-empty registry. */
export async function loadRoster(
  cmd: string = process.env.GUILDMASTER_ROSTER_CMD || "roster.sh",
  team: string | undefined = process.env.BRIDGE_TEAM,
): Promise<Teammate[]> {
  if (!team) {
    logger.warn("[roster] BRIDGE_TEAM not set; roster registry is empty");
    return [];
  }
  try {
    const { stdout } = await execFileAsync(cmd, ["--team", team, "--json"], { encoding: "utf-8", timeout: 5_000 });
    return parseRoster(stdout, team);
  } catch (err: unknown) {
    logger.warn("[roster] load failed; treating roster as empty", { error: errorMessage(err) });
    return [];
  }
}
