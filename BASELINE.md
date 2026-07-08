# Baseline & test-gate policy — `feat/dreamteam-bridge`

This fork's `npm run check` (= `biome check .` → `tsc --noEmit` root → `tsc --noEmit` ui →
`vitest run`) was **not clean at the branch point** (upstream `jphein/AgentManager` @ HEAD).
Recorded here so the per-task green bar is unambiguous during the dreamteam-bridge work.

## Fixed to unblock the gate (pre-req commit)
- **ui `src/views/PullRequests/PullRequestsView.test.ts` `makePR()`** — the test fixture had
  drifted from the `PullRequestItem` type: (1) `draft` → `isDraft` (renamed field), and
  (2) missing required `createdAt`. Both were deterministic `tsc --noEmit` (ui) errors that
  failed `npm run check` every run. Fixed in the test fixture only — **upstream defect, a
  candidate to PR upstream to `simonstaton/AgentManager`**. No product code touched.

## Known-flaky tests (timer-sensitive — DO NOT "fix" during this work)
`vitest run` is green on a good run (848/848) but these occasionally fail on a cold/loaded
run and **pass on one re-run** (foreign timing code, out of scope for the bridge):
- `src/orchestrator.test.ts` — `submitResult` retry / `decomposeGoal` / `assignmentCycle`
- `src/scheduler.test.ts` — `create()` cron-expression jobs
- `src/routes/hook-config.test.ts` — storage-failure 500 timeout
- `src/routes/tokens.test.ts` — validationWarning timeout

## Per-task gate (ruled by team-lead, 2026-07-08)
`npm run check` **green**, where **only the named tests above** may fail intermittently and
**must pass on ONE re-run**. Any NEW failing test, or a flaky that stays red on re-run, means
the task is RED. The flaky list is **never widened without a ruling**. The flaky tests are
**not fixed** here (foreign timing code, note-and-move-on).
