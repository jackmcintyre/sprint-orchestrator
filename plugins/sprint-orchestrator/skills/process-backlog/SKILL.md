---
name: process-backlog
description: Drive the sprint backlog by claiming ready stories one at a time and routing each through the dev + reviewer subagents.
user-invocable: true
allowed-tools:
  - "mcp__sprint-orchestrator__getOrInitConfig"
  - "mcp__sprint-orchestrator__getSprintStatus"
  - "mcp__sprint-orchestrator__getReadyStories"
  - "mcp__sprint-orchestrator__claimStory"
  - "mcp__sprint-orchestrator__releaseStaleClaims"
  - "Task"
---

You orchestrate sprint execution. You do not implement stories yourself and you do not mark stories complete or failed — both happen inside subagents whose tool permissions are scoped for the job.

## Setup (run once per invocation)

1. Call `getOrInitConfig`. If `needsSetup` is true, ask the user the `setupQuestions` it returned, then stop and tell them to re-invoke once their layout is documented in `.sprint-orchestrator/config.yaml`. Do not guess paths.

## Main loop

Repeat until either `getReadyStories` returns `[]` or you have completed **5 stories this run** (hard cap to protect context):

1. Call `getReadyStories`. If empty, write a one-line summary of what was done across the run and stop.
2. Pick the first ready story `S`. Generate a fresh agent ID: `dev-<session-id-or-timestamp>`.
3. Call `claimStory` with `S.id` and that agent ID. If `claimed` is false (another orchestrator beat you to it), skip to the next ready story.
4. Spawn a `dev` subagent via the `Task` tool. Pass the story ID in the prompt. Wait for it to return.
5. Spawn a `reviewer` subagent for the same story ID via `Task`, passing both the story ID and the same agent ID you used in step 3. The reviewer will call `markStoryComplete` or `markStoryFailed` itself.
6. After the reviewer returns, log a one-line status (`done: <id>` or `blocked: <id> — <reason>`).
7. Loop.

## Rules

- One story at a time in v1 (sequential, MAX=1 concurrency).
- If a `dev` subagent returns without producing any change, still run the `reviewer` — it will fail the story and surface the structured reason.
- Do not call `markStoryComplete` or `markStoryFailed` directly. You don't have permission and shouldn't try.
- If you see stale claims (stories stuck in `in_progress` from a prior crashed run), the user can call `releaseStaleClaims` themselves — do not call it automatically.
- Never narrate intermediate work. One status line per story is enough.
