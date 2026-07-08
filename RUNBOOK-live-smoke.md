# Live smoke test — dreamteam bridge (JP-gated)

> **needs-JP.** This is the ONLY procedure that spawns real agents / spends tokens. Do NOT
> run it during plan execution. It requires JP's decisions: (a) auth provisioning for spawned
> agents (teamclaude-proxy vs direct `ANTHROPIC_API_KEY`), and (b) sign-off that a 2-agent
> live fleet is acceptable.

Preconditions (JP to confirm): auth mode decided; 2-agent fleet approved; kill switch armed.

Caps (hard): max 2 agents; smallest practical contexts (Haiku, tiny prompts); kill every
spawned process on exit; abort if `free -m` available < 8 GB.

1. `export BRIDGE_SPAWN_MODE=dreamteam BRIDGE_HOME=~/.guildmaster/bridge BRIDGE_TEAM=<the live team>`
2. Arm kill switch check: confirm `bridgeHome()/platform/` is writable and NOT inside any agent
   workspace (the fork roots it under `~/.guildmaster/bridge`, which is not symlinked into workspaces).
3. `npm run dev` (server + UI). Confirm the dashboard loads and the cost pane reads $0.
4. Implement the dreamteam-side consumer (OUT of this plan — see `docs/dreamteam-bridge-contract.md`):
   drain `outbound/`, call native `SendMessage(to, content)` from a live Claude Code session, write
   `acks/<id>.json`. Verify with ONE message first (send via dashboard → confirm a `delivered` ack is
   written → confirm the message goes read in the UI, and the handoff moves to `delivered/`).
5. Spawn 2 Haiku agents via `POST /api/agents` (dreamteam mode → `spawn-requests/`). Wire the consumer
   to action them via dreamteam (roster-gated). Confirm they appear in `roster.sh --team <team> --json`.
6. Send a task to each; confirm the delivery-ack round trip (markRead only on `delivered`) and that
   an unknown/dead target surfaces an UNDELIVERED info message back to the sender (not a death claim —
   it should point at `gm peek`).
7. Kill-switch drill: activate; confirm no new deliveries occur and agents stop.
8. Teardown: destroy agents, confirm no orphan `claude` procs (`pgrep -af claude`), disarm the kill switch.

Rollback: `git checkout main` in the fork; the bridge is opt-in (`BRIDGE_SPAWN_MODE`), so native mode
is unaffected if the smoke is aborted.
