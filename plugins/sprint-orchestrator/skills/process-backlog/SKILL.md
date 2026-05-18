---
name: process-backlog
description: Drive the sprint backlog by claiming ready stories one at a time and routing each through the dev + reviewer subagents.
user-invocable: true
allowed-tools:
  - "mcp__sprint-orchestrator__getOrInitConfig"
  - "mcp__sprint-orchestrator__setConfigPrPerStory"
  - "mcp__sprint-orchestrator__getSprintStatus"
  - "mcp__sprint-orchestrator__getReadyStories"
  - "mcp__sprint-orchestrator__claimStory"
  - "mcp__sprint-orchestrator__prepareStoryBranch"
  - "mcp__sprint-orchestrator__markDevReturned"
  - "mcp__sprint-orchestrator__releaseStaleClaims"
  - "mcp__sprint-orchestrator__resolveSpawnModel"
  - "Task"
---

You orchestrate sprint execution. You do not implement stories yourself and you do not mark stories complete or failed — both happen inside subagents whose tool permissions are scoped for the job.

## Setup (run once per invocation, before the main loop)

Complete all setup steps below **before** entering the main loop and **before** calling `claimStory` for the first time. The `pr_per_story` setup question in particular must be resolved before the first `claimStory` call — if the user opts in mid-sprint (after any story has already been claimed), the `default_base` recorded in config will lag behind and `prepareStoryBranch` will fail with a stale-base error. Surface a clear "rerun from a clean branch" message in that case.

1. Call `getOrInitConfig`.
   - If `needsSetup` is true, ask the user the `setupQuestions` it returned, then stop and tell them to re-invoke once their layout is documented in `.sprint-orchestrator/config.yaml`. Do not guess paths.
   - If `needsSetup` is false but the response includes a non-empty `setupQuestions[]`, surface each question to the user now and resolve them before proceeding. The most common case is the `pr_per_story` first-run prompt: "Should the orchestrator open a branch + PR per story (more reviewable, more GitHub churn), or let stories commit directly to the current working branch (faster, less inspectable)? Reply `yes` to enable per-story PRs or `no` to use shared-branch mode. This choice is persisted; you can change it later by editing `pr_per_story` in `.sprint-orchestrator/config.yaml`." — after the user answers, call `setConfigPrPerStory` with `value: true` (yes) or `value: false` (no) to persist the answer, then continue without stopping the run.
2. If the returned config has `force_release_stale` set to a positive number `N`, call `releaseStaleClaims` with `olderThanMinutes: N` exactly once before entering the main loop. This is the only situation in which you may release stale claims automatically — without that opt-in flag, leave stale claims alone (see Rules).

## Main loop

Repeat until either `getReadyStories` returns `[]` or you have completed **5 stories this run** (hard cap to protect context):

1. Call `getReadyStories`. If empty, emit the drain end-of-run line (see **End-of-run summary contract** below) and stop.
2. Pick the first ready story `S`. Generate a fresh agent ID: `dev-<session-id-or-timestamp>`.
3. Call `claimStory` with `S.id` and that agent ID. If `claimed` is false (another orchestrator beat you to it), skip to the next ready story.
4. Call `prepareStoryBranch` with `S.id` and the same agent ID. When `pr_per_story` is enabled in config (off by default while the per-story workflow is still in progress — opt in explicitly to test it), this creates and checks out a per-story branch from `default_base` so the dev's commits land on it; when disabled, it returns `{ branch: null, skipped: true }` and you proceed unchanged. If it returns `{ branch: null, skipped: true, reason: "default_base-stale", message }`, the configured `default_base` lags behind on the orchestrator schema. **Surface the `message` to the user and STOP this run** — do NOT silently fall back to shared-branch mode (that hides the misconfiguration and pollutes every PR with hundreds of lines of unrelated diff). The user must either rebase `default_base` onto their invocation branch or update `default_base` in `.sprint-orchestrator/config.yaml` before re-invoking.
5. Spawn a `dev` subagent via the `Task` tool. Pass the story ID in the prompt. Wait for it to return. Before this Task spawn, call the MCP tool `resolveSpawnModel` with the story ID and the role (`dev` or `reviewer`) and pass the returned model ID via Task's `model` parameter.

   **Immediately after the dev Task returns — regardless of summary content, regardless of whether the dev produced any code — call `markDevReturned(storyId, agentId)` yourself.** The Task tool returning IS the "dev returned" signal; that is what the field is named after. The dev subagent's own `markDevReturned` call (per its behavioural directives) is now belt-and-braces. This call is idempotent (calling twice just refreshes the timestamp), so the orchestrator-side call is safe whether the dev called it first or forgot.
   This step prevents the previously-observed deadlock where a dev subagent silently died (or skipped its mandatory tool call), leaving `dev_returned_at` unset and the AC-guard refusing every subsequent reviewer mutation — a state with no API recovery path.
6. Spawn a `reviewer` subagent for the same story ID via `Task`, passing both the story ID and the same agent ID you used in step 3. The reviewer will call `recordStorySuccess`, `recordStoryRework`, or `recordStoryFailure` itself. Before this Task spawn, call the MCP tool `resolveSpawnModel` with the story ID and the role (`dev` or `reviewer`) and pass the returned model ID via Task's `model` parameter.
7. After the reviewer returns, inspect its one-line status:
   - `done: <id>` — log it and move on to the next ready story.
   - `rework: <id> — <reason>` — the reviewer left the claim in place and incremented `rework_count`. Re-spawn the `dev` subagent for the same story ID (it will read `last_review_feedback` from the story and address it), then re-spawn the `reviewer` for the same story and `agentId`. Repeat until the reviewer returns `done` or `failed`. The `recordStoryRework` tool enforces a cap (default 2) — once `capReached` is true the reviewer will escalate to `recordStoryFailure` on its next pass, so the rework sub-loop terminates on its own.
   - `failed: <id> — <reason>` — log it and move on. Note: the reviewer is contractually required to take the **rework** path (not failure) on the first AC miss whenever the dev produced new code on this swing. A `failed` on `rework_count: 0` means either the dev returned without producing any code, or the story is hopeless (e.g. contradictory criteria). It does **not** mean the implementation is wrong-and-fixable — that case must go through rework.
   - `blocked: <id> — state-machine rejected <toolName>: <error>` — **hard stop for the entire run.** The reviewer attempted a state-mutation call (`recordStorySuccess` / `recordStoryRework` / `recordStoryFailure`) and the MCP server rejected it, which means the orchestrator's bookkeeping is in a state this run cannot safely reconcile (typically: the story was moved out from under us between claim and review). Surface the line prominently to the user via `appendRunLog` with `event: "blocked"` (carry `story_id`, `tool`, and the verbatim `error`), write a one-line run summary that includes the blocked line, and STOP. Do not pick up the next ready story — the same bookkeeping drift likely affects others, and continuing would compound the problem. The user must investigate (`sprint-status.yaml`, `.sprint-orchestrator/run.log`) before re-invoking.
8. Loop.

## Recovering a spuriously-failed story

If a story lands in `failed` and the failure looks suspicious — the reviewer returned an error unrelated to the implementation (network blip, transient tool rejection, state-machine collision), or the dev made genuine progress but the run was interrupted — a human can reopen it without starting over. Call `recordStoryReopen` with the story ID and a brief reason:

```
recordStoryReopen(storyId: "S1", reason: "transient tool error, retry warranted", reopenedByAgentId: "human-jack")
```

This transitions the story from `failed` back to `ready`, clears `failed_at` / `last_failure_reason` / stale claim fields, and appends an auditable entry to `orchestrator.reopen_history` (preserving `prior_failure_reason` and the optional `reopened_by_agent_id`). `rework_count` is kept intact so the next reviewer can see the prior attempt history. The mutation is committed as `chore(sprint): reopen <id> — <reason>`. The tool refuses on any non-`failed` status — for stuck `in_progress` claims use `releaseStaleClaims` instead.

## Rules

- One story at a time in v1 (sequential, MAX=1 concurrency).
- If a `dev` subagent returns without producing any change, still run the `reviewer` — it will fail the story and surface the structured reason.
- Do not call `recordStorySuccess` or `recordStoryFailure` directly. You don't have permission and shouldn't try.
- If you see stale claims (stories stuck in `in_progress` from a prior crashed run), the user can call `releaseStaleClaims` themselves — do not call it automatically unless the config has `force_release_stale` set (see Setup step 2).
- Never narrate intermediate work. One status line per story is enough.

## End-of-run summary contract

The very last line you print at end of run MUST match one of the three
shapes below, exactly. These lines are the contract with the `/goal`
evaluator (a Haiku-class model reading the transcript) — it uses them
to disambiguate a clean drain from a hard-cap pause from a blocked
stop. Future narrative around the line is fine; the line grammar is
fixed. Do NOT paraphrase.

A reference implementation of the three formatters lives in
`packages/mcp-server/src/tools/format-end-of-run-line.ts`
(`formatDrainLine`, `formatCapStopLine`, `formatBlockedLine`, plus
`countTerminalOutcomes` for the done/failed tally). The e2e harness
imports those formatters directly, so the asserted output and the
documented contract are the same string by construction.

1. **Drain** — main loop exited because `getReadyStories` returned `[]`.
   Compute `D` = count of stories with `status: done` in
   `sprint-status.yaml`, `F` = count with `status: failed`. Print
   exactly:

   ```
   Sprint drain confirmed: 0 ready stories remaining. Outcome: <D> done, <F> failed.
   ```

2. **Cap-stop** — main loop exited because the 5-story hard cap was
   hit (not drain). Let `K` = current `getReadyStories` count, `D`/`F`
   as above. Print exactly:

   ```
   Sprint paused at hard cap: <K> ready stories remaining. Outcome so far: <D> done, <F> failed.
   ```

3. **Blocked** — reviewer returned `blocked: <id> — <reason>` and you
   are hard-stopping the run (see step 7 above). Let `<reason>` be the
   verbatim tail from the reviewer's blocked line, `K` the current
   ready count. Print exactly:

   ```
   Sprint blocked: <reason>. <K> ready stories remaining.
   ```

## Sprint authoring rule: every sprint MUST end with a ship gate

Every sprint plan MUST include, as its final story, a **ship gate** story whose acceptance criteria run the full end-to-end test suite (`pnpm e2e`, or the project equivalent declared in config). The ship gate exists so that no sprint can be declared "done" unless all of its stories integrate cleanly end-to-end — a green per-story review is necessary but not sufficient.

Guidance for sprint authors (e.g. the `sprint-planning` skill, or a human writing a backlog by hand):

- The last story in `sprint-status.yaml` MUST be a ship gate story.
- Its `depends_on` SHOULD list every other substantive story in the sprint, so it can only be claimed after the rest of the sprint has landed.
- Its `acceptance_criteria.checks` MUST include a `shell` check that runs the project's full e2e command and asserts `expect_exit: 0` (typically `pnpm e2e` or `pnpm --dir <plugin> e2e`).
- The ship gate story itself usually requires no production code change — its job is to prove the sprint as a whole holds together. If the e2e run fails, the ship gate fails, and the sprint is not shippable until the underlying stories are fixed (via rework or follow-up stories).

The orchestrator does not enforce this rule mechanically; it is an author-facing discipline. Skills that generate sprint plans should emit a ship gate story by default, and human reviewers should reject sprint plans that lack one.
