---
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories", "step-04-final-validation"]
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - scoped-tasks-from-conversation
---

# claude-dev-loop / sprint-orchestrator — Epic Breakdown

## Overview

This document provides the epic and story breakdown for the next iteration of the `sprint-orchestrator` Claude Code plugin. Phases 1–4 plus four follow-up fixes have already shipped. This breakdown formalizes the **eight scoped polish/feature items** that came out of an iteration-planning discussion, organized for delivery via the same plugin (dogfood: the orchestrator processes its own backlog).

## Requirements Inventory

### Functional Requirements

The following FRs are extracted from `project.md` (the original build spec) and the eight scoped follow-up items.

**Already shipped (FR-001 … FR-008) — context only, not in scope for this sprint:**

- **FR-001** The plugin exposes a deterministic MCP server with state-management tools (`getSprintStatus`, `getReadyStories`, `claimStory`, `markStoryComplete`, `markStoryFailed`, `validateAcceptanceCriteria`, `releaseStaleClaims`, `getStoryContext`, `getOrInitConfig`, `commitStoryArtefacts`).
- **FR-002** A `process-backlog` skill drives the backlog by spawning `dev` and `reviewer` subagents per ready story.
- **FR-003** Pre-tool-use, post-tool-use, and stop hooks enforce guardrails and finalise stories.
- **FR-004** The reviewer commits artefacts per story before marking complete.
- **FR-005** The stop hook tidy-commits leftover `sprint-status.yaml` metadata edits.
- **FR-006** Sprint state is stored in `sprint-status.yaml`; reads/writes are atomic via file locking.
- **FR-007** BMAD v6 layout is auto-detected; otherwise the agent surfaces setup questions to the user.
- **FR-008** Hooks deny destructive Bash patterns, path-escape writes, and disallowed URLs.

**New, in scope for this sprint (FR-009 … FR-016):**

- **FR-009** When a reviewer rejects a story whose `rework_count` is below `rework_limit` (default 2), the story shall remain `in_progress` with `claimed_by` unchanged, and the reviewer shall record the failure reason via a new MCP tool `markStoryNeedsRework(storyId, agentId, reason)`.
- **FR-010** When a reviewer rejects a story whose `rework_count` has reached `rework_limit`, the reviewer shall call `markStoryFailed` with a cumulative reason naming all attempts.
- **FR-011** The orchestrator skill shall, after `Task(reviewer)` returns, re-read the story state; if still `in_progress`, it shall spawn a fresh `dev` subagent and pass the prior reviewer feedback as primary specification context.
- **FR-012** The system shall expose a read-only MCP tool `getSprintReport()` that returns a structured per-status story summary plus a short rendered text version suitable for chat display.
- **FR-013** When `claimStory` succeeds and when any `mark*` tool fires, a structured `story_start` / `story_end` event shall be appended to `.sprint-orchestrator/run.log` (one JSON line per event).
- **FR-014** A `force_release_stale` boolean in `.sprint-orchestrator/config.yaml`, when true, shall cause the `process-backlog` skill to call `releaseStaleClaims(60)` at the start of each invocation.
- **FR-015** The plugin README shall include a three-command quickstart block above the install section: marketplace add, plugin install, and `/loop /sprint-orchestrator:process-backlog`.
- **FR-016** The plugin README shall include a workflow lifecycle diagram covering the per-story phases (Pick → Claim → Implement → Review → Loop → Stop hook).

### Non-Functional Requirements

Extracted from `project.md` quality bars; preserved for the new work:

- **NFR-001** TypeScript strict mode, no `any` (use `unknown` and narrow).
- **NFR-002** Every public function carries a JSDoc with `@throws` documented.
- **NFR-003** Every MCP tool input/output is validated through `zod`.
- **NFR-004** Test coverage targets: ≥90 % on `packages/mcp-server`; ≥80 % on `packages/hooks`.
- **NFR-005** No `process.exit()` outside `main()` entry points.
- **NFR-006** Structured logging via library logger or `process.stdout.write` of JSON — never `console.log` in library code (hook entry points permitted to write to stderr for human-readable status).
- **NFR-007** Total external dependencies kept under 20 production packages across all workspaces.
- **NFR-008** Plugin must remain installable via local marketplace and runnable on the user's Claude Max subscription (no API-key dependency in the supported deployment path).
- **NFR-009** No business logic in skill or agent markdown — decision trees go in TypeScript (MCP server) so they're unit-testable.

### Additional Requirements

Drawn from the as-built architecture (`plugins/sprint-orchestrator/README.md` + repo state):

- The codebase uses **pnpm workspaces** with two packages: `@sprint-orchestrator/mcp-server` and `@sprint-orchestrator/hooks`. New code lives in one of these — do not introduce a third package for the items in this sprint.
- Errors throw typed subclasses of a single base error class (currently `BmadError`; one story in this sprint renames it).
- Hooks are authored in TypeScript and compiled to `packages/hooks/dist/` — `hooks/hooks.json` references the compiled `.js`.
- All MCP state mutations must go through `proper-lockfile`'s `withLock`; no direct file writes outside the lock.
- The reviewer agent decision tree is implemented as a prompt in `agents/reviewer.md`; the agent calls MCP tools rather than encoding the policy inline.

### UX Design Requirements

Not applicable — this is a developer-facing CLI plugin with no UI.

### FR Coverage Map

| Requirement | Epic / Story |
|---|---|
| FR-009 (rework: state model) | Epic 1 / Story 1.1 |
| FR-009 (rework: MCP tool) | Epic 1 / Story 1.2 |
| FR-009, FR-010, FR-011 (rework: agent prompts + skill loop) | Epic 1 / Story 1.3 |
| FR-012 (getSprintReport) | Epic 2 / Story 2.1 |
| FR-013 (run.log lifecycle events) | Epic 2 / Story 2.2 |
| FR-014 (force_release_stale) | Epic 2 / Story 2.3 |
| FR-015 (README quickstart) | Epic 3 / Story 3.1 |
| FR-016 (workflow diagram) | Epic 3 / Story 3.2 |
| NFR-001..009 | Apply across all stories; enforced via AC running `pnpm verify` |
| Rename `BmadError` → `OrchestratorError` (cross-cutting) | Epic 0 / Story 0.1 (lands first) |
| `pnpm verify` root script (cross-cutting) | Epic 0 / Story 0.2 (lands second) |

## Epic List

### Epic 0: Foundational cleanup

Developers and future contributors stop seeing `BMAD`-branded identifiers in error output (the plugin already works for any BMAD-compatible or hand-rolled sprint layout, but the error class name and codes leak the legacy framing). A single `pnpm verify` command at the repo root runs the full quality pipeline so contributors stop needing the four-command recipe from memory.

**User outcome:** consistent identifier vocabulary across the codebase; one-command pre-merge check.
**FRs covered:** none directly — supports NFRs 001–009 by making the quality gate easy to run.
**Lands first:** Story 0.1 changes file paths/imports that every later story will edit, and Story 0.2 lets every later story prove green with a single command.

### Epic 1: Self-healing reviews via bounded rework

When the dev subagent's first attempt at a story doesn't pass review, the orchestrator gives the dev another shot with the reviewer's feedback as additional context — instead of immediately marking the story blocked. Up to `rework_limit` rounds (default 2) before the story is declared blocked. The same dev claim persists across rework rounds, so the story is one continuous unit of work, not a series of restarts.

**User outcome:** sprints absorb the kind of "close-but-not-quite" first attempts that today require manual reset; fewer human interventions per run.
**FRs covered:** FR-009, FR-010, FR-011.
**Depends on:** Epic 0 Story 0.1 (errors module rename).

### Epic 2: Sprint observability and resilience

Developers can see the sprint at a glance via a new `getSprintReport` tool that returns both structured JSON and a one-screen rendered text view. The `.sprint-orchestrator/run.log` becomes a real audit trail — every `claimStory` and `mark*` invocation appends a structured event. A new `force_release_stale` config flag opt-in lets the orchestrator self-recover from claims orphaned by a prior crashed run.

**User outcome:** users can ask "what's the sprint state?" and get a useful answer; post-mortems against `run.log` are tractable; crash recovery doesn't need manual `releaseStaleClaims` calls.
**FRs covered:** FR-012, FR-013, FR-014.
**Depends on:** Epic 0 (typed errors carry the new name).

### Epic 3: Documentation polish

A new developer (or future Jack returning after a month away) can install the plugin from a three-line block at the top of the README, and the workflow lifecycle diagram makes the per-story phases legible without having to ask Claude to explain them.

**User outcome:** zero-friction install; the README answers "how does this thing actually run a story?" without an Anthropic round-trip.
**FRs covered:** FR-015, FR-016.
**Depends on:** none — markdown-only.

## Epic dependency graph

```
Epic 0 (foundational)
   │
   ├──► Epic 1 (rework loop)
   │
   └──► Epic 2 (observability)
           ▲
           │
        Epic 3 (docs) — independent of the others, but ideally lands
        after Epics 1 & 2 so the diagram and quickstart reflect the
        final shape.
```

## Implementation efficiency review

Cross-epic file-overlap audit:

| File / area | Touched by |
|---|---|
| `packages/mcp-server/src/lib/errors.ts` | Epic 0 Story 0.1 (rename) — no later story re-touches it |
| `packages/mcp-server/src/state/schema.ts` | Epic 1 Story 1.1 (schema additions) only |
| `packages/mcp-server/src/tools/*.ts` | Epic 1 Story 1.2 (new tool), Epic 2 Story 2.1 (new tool) — different files |
| `agents/reviewer.md`, `agents/dev.md` | Epic 1 Story 1.3 only |
| `skills/process-backlog/SKILL.md` | Epic 1 Story 1.3 (rework branch) **and** Epic 2 Story 2.3 (`force_release_stale`) — coordinated via story order |
| `packages/hooks/src/post-tool-use.ts` | Epic 2 Story 2.2 only |
| `plugins/sprint-orchestrator/README.md` | Epic 3 Stories 3.1, 3.2 (sequential within Epic 3) |

The skill file is the only cross-epic shared file, and the changes are in different sections of the file (rework branch in the loop body vs. `force_release_stale` at the top). I'll order Epic 1 Story 1.3 before Epic 2 Story 2.3 to avoid a merge conflict.

---

## Epic 0: Foundational cleanup

Stop "BMAD"-branded identifiers leaking out of the deterministic core, and give contributors a one-command quality gate.

### Story 0.1: Rename `BmadError` to `OrchestratorError`

As a contributor to the plugin codebase,
I want the base error class and its error codes to be named after the plugin (`OrchestratorError`, `"ORCH_*"`),
So that error output reflects the plugin's actual identity and doesn't confuse readers about the BMAD relationship.

**Acceptance Criteria:**

**Given** the mcp-server source under `plugins/sprint-orchestrator/packages/mcp-server/src/`,
**When** I grep for `BmadError`,
**Then** there are zero matches.

**Given** the same source tree,
**When** I grep for `"BMAD_` as an error-code prefix,
**Then** there are zero matches.

**Given** the rename is complete,
**When** I run `pnpm verify` (or the four pre-`verify` commands manually),
**Then** all checks exit zero.

**And** all 34 pre-rename tests still pass with the new symbol names.

### Story 0.2: Add `pnpm verify` root script

As a contributor (and CI),
I want a single `pnpm verify` command at the repo root that runs typecheck, build, test, and lint,
So that the quality gate is one command instead of four and CI uses the same definition the developer uses locally.

**Acceptance Criteria:**

**Given** `plugins/sprint-orchestrator/package.json`,
**When** I read `scripts.verify`,
**Then** it runs `pnpm -r typecheck && pnpm -r build && pnpm -r test && pnpm lint` (any equivalent ordering that still exits non-zero on any failure is acceptable).

**Given** `.github/workflows/ci.yml`,
**When** I read its run steps,
**Then** the prior four-step recipe is replaced by a single `pnpm verify` step (install + build prerequisite preserved as needed).

**Given** a clean checkout,
**When** I run `pnpm install --frozen-lockfile && pnpm verify`,
**Then** both commands exit zero.

---

## Epic 1: Self-healing reviews via bounded rework

Let the orchestrator re-attempt a failed story with the reviewer's feedback in hand, bounded by a per-project cap.

### Story 1.1: Extend state schema with rework tracking fields

As the orchestrator state machine,
I want the per-story `orchestrator` metadata block to optionally carry `rework_count`, `last_review_feedback`, and `last_review_at`,
So that reviewers and the skill loop have a place to record and read rework attempts without inventing ad-hoc fields.

**Acceptance Criteria:**

**Given** `packages/mcp-server/src/state/schema.ts`,
**When** I read the `OrchestratorMeta` schema,
**Then** it declares optional fields `rework_count` (non-negative integer), `last_review_feedback` (string), and `last_review_at` (ISO 8601 datetime string).

**Given** a pre-rework `sprint-status.yaml` (no rework fields on any story),
**When** I call `readSprintStatus`,
**Then** parsing succeeds and the missing fields are undefined on each story.

**Given** a sprint-status with rework fields set,
**When** the file is round-tripped via `readSprintStatus` → `writeSprintStatus`,
**Then** the rework fields survive the round-trip unchanged.

**Given** the new schema fields,
**When** `pnpm --filter @sprint-orchestrator/mcp-server test` runs,
**Then** all prior tests pass and at least three new tests cover the new fields (defaults, round-trip, schema rejection of negative `rework_count`).

**And** `pnpm verify` exits zero.

### Story 1.2: Add `markStoryNeedsRework` MCP tool

As the reviewer subagent,
I want a dedicated MCP tool that records a failed-review attempt and returns whether the cap has been reached,
So that I can route my decision (rework vs. final fail) using a deterministic server response instead of inline markdown logic.

**Acceptance Criteria:**

**Given** the mcp-server package,
**When** I read `packages/mcp-server/src/tools/mark-story-needs-rework.ts`,
**Then** it exports `markStoryNeedsRework(ctx, storyId, agentId, reason)` returning `{ reworkCount: number, capReached: boolean }`.

**Given** the MCP server is running,
**When** I send a `tools/list` request,
**Then** `mcp__sprint-orchestrator__markStoryNeedsRework` appears with a zod-validated input schema.

**Given** a story claimed by `agent-x` with `rework_count: 0` and the project-wide `rework_limit: 2`,
**When** `markStoryNeedsRework` is called with `agentId: "agent-x"` and a non-empty reason,
**Then** the story's `rework_count` becomes `1`, `last_review_feedback` is set to the reason, `last_review_at` is an ISO timestamp, `status` stays `in_progress`, `claimed_by` is unchanged, and the response is `{ reworkCount: 1, capReached: false }`.

**Given** the same story now at `rework_count: 1`,
**When** the tool is called again,
**Then** `rework_count` becomes `2` and the response is `{ reworkCount: 2, capReached: true }` — the tool never changes status to `blocked` itself.

**Given** a story claimed by `agent-x`,
**When** `markStoryNeedsRework` is called with `agentId: "someone-else"`,
**Then** a `ClaimConflictError` is thrown.

**Given** a story whose status is not `in_progress` (e.g. `ready` or `done`),
**When** the tool is called,
**Then** an `InvalidStateTransitionError` is thrown.

**And** `pnpm verify` exits zero.

### Story 1.3: Wire reviewer + dev + skill into the rework loop

As an operator running the orchestrator unattended,
I want a failed review to trigger a fresh dev attempt with the reviewer's feedback as primary context, bounded by `rework_limit`,
So that close-but-not-quite stories self-heal instead of stalling on `blocked` until I intervene.

**Acceptance Criteria:**

**Given** `agents/reviewer.md`,
**When** I read it,
**Then** it describes the three-path decision tree (`pass` → commit + complete; `fail under cap` → `markStoryNeedsRework`; `fail at cap` → `markStoryFailed` with a cumulative reason naming each attempt) and lists `markStoryNeedsRework` in its `allowed-tools` frontmatter.

**Given** `agents/dev.md`,
**When** I read it,
**Then** it instructs the dev that any `last_review_feedback` it receives in its prompt is the primary specification for this attempt and to focus edits on the failing checks rather than redoing what worked.

**Given** `skills/process-backlog/SKILL.md`,
**When** I read it,
**Then** it documents: after `Task(reviewer)` returns, re-read story state; if still `in_progress`, spawn a fresh `Task(dev)` with the prior `last_review_feedback` included, then `Task(reviewer)` again; bound by `rework_limit`.

**Given** a mock reviewer that fails AC once on the first attempt and passes on the second,
**When** the skill processes that story end-to-end,
**Then** the story ends with `status: done`, `rework_count: 1`, exactly one commit is produced (via `commitStoryArtefacts`), and the orchestrator log records both attempts.

**Given** a mock reviewer that fails AC on every attempt,
**When** the skill processes that story,
**Then** the story ends with `status: blocked`, `rework_count` equal to `rework_limit`, and `last_failure_reason` mentions every rejected attempt.

**And** `pnpm verify` exits zero.

---

## Epic 2: Sprint observability and resilience

Make sprint state legible at a glance, give `run.log` real audit value, and let the orchestrator recover from crashed prior runs.

### Story 2.1: Add `getSprintReport` MCP tool

As an operator,
I want a single read-only MCP tool that returns a status summary of the current sprint plus a human-readable rendering,
So that I can ask Claude "show me the sprint" and get an answer without composing or formatting `getSprintStatus` output myself.

**Acceptance Criteria:**

**Given** the mcp-server package,
**When** I read `packages/mcp-server/src/tools/get-sprint-report.ts`,
**Then** it exports `getSprintReport(ctx)` returning `{ counts, stories, rendered }` where `counts` totals stories per status (`backlog`, `ready`, `in_progress`, `done`, `blocked`), `stories` is an array of `{ id, title, status, summary?, lastFailure? }`, and `rendered` is a multi-line string formatted for chat display.

**Given** the MCP server,
**When** I issue a `tools/list`,
**Then** `mcp__sprint-orchestrator__getSprintReport` appears with no required input parameters and is read-only (no state mutation).

**Given** a fixture sprint with stories spanning all five statuses,
**When** `getSprintReport` is called,
**Then** `counts` tallies each status correctly and `rendered` contains the id and title of every story.

**Given** a story that was marked `blocked` with a `last_failure_reason`,
**When** the report is generated,
**Then** that story's entry includes the `lastFailure` field with the recorded reason.

**And** `pnpm verify` exits zero.

### Story 2.2: Append lifecycle events to `.sprint-orchestrator/run.log`

As an operator running the orchestrator unattended,
I want every story claim and every `mark*` invocation recorded as a structured event in `run.log`,
So that I can reconstruct a run's history from the log alone without re-reading sprint-status diffs.

**Acceptance Criteria:**

**Given** the post-tool-use hook source,
**When** I read it,
**Then** it detects calls to `mcp__sprint-orchestrator__claimStory` and to any `mcp__sprint-orchestrator__markStory*` tool and appends a single JSON line to `<projectRoot>/.sprint-orchestrator/run.log` containing at minimum `{ at, event, storyId, agentId?, result? }`.

**Given** a session that calls `claimStory("S1", "agent-1")` and then `markStoryComplete("S1", "agent-1", ...)`,
**When** I read `run.log` afterward,
**Then** it contains exactly one `story_start` event with `storyId: "S1"` and one `story_end` event with `storyId: "S1"` and the resulting status.

**Given** the hooks test suite,
**When** `pnpm --filter @sprint-orchestrator/hooks test` runs,
**Then** at least two new tests cover the `story_start` and `story_end` log emission paths.

**And** `pnpm verify` exits zero.

### Story 2.3: Add `force_release_stale` skill option

As an operator recovering from a crashed prior run,
I want an opt-in `force_release_stale` flag in `.sprint-orchestrator/config.yaml` that auto-releases stale claims at the start of each invocation,
So that I don't have to remember to call `releaseStaleClaims` myself after a crash.

**Acceptance Criteria:**

**Given** the config schema in `packages/mcp-server/src/tools/get-or-init-config.ts`,
**When** I read it,
**Then** `force_release_stale` is a recognised optional boolean field (default `false`).

**Given** `.sprint-orchestrator/config.yaml` containing `force_release_stale: true`,
**When** `/sprint-orchestrator:process-backlog` runs,
**Then** the skill calls `releaseStaleClaims(60)` before its first `getReadyStories` call and the iteration log records the released story IDs (if any).

**Given** config containing `force_release_stale: false` (or the field absent),
**When** the skill runs,
**Then** `releaseStaleClaims` is not auto-invoked.

**Given** `skills/process-backlog/SKILL.md`,
**When** I read it,
**Then** it documents the new option, its default (`false`), and that the skill — not the user — calls the tool when the flag is set.

**And** `pnpm verify` exits zero.

---

## Epic 3: Documentation polish

Zero-friction onboarding and a visible per-story lifecycle.

### Story 3.1: Add quickstart block to the plugin README

As a developer encountering the plugin for the first time,
I want a fenced code block at the top of `plugins/sprint-orchestrator/README.md` showing the three commands to install and run it,
So that I can be up and running in under a minute without scanning the whole document.

**Acceptance Criteria:**

**Given** `plugins/sprint-orchestrator/README.md`,
**When** I read the first non-title section after the project name,
**Then** it contains a single fenced code block with three commands in this order: `/plugin marketplace add <path>`, `/plugin install sprint-orchestrator@sprint-orchestrator-local`, and `/loop 30m /sprint-orchestrator:process-backlog`.

**Given** the README,
**When** I grep for "marketplace add",
**Then** the first occurrence is inside the quickstart block (not later in the Install section).

**And** `pnpm verify` exits zero.

### Story 3.2: Add story-lifecycle diagram to the plugin README

As a contributor or future maintainer,
I want a per-story lifecycle diagram in the README naming each phase and the MCP tools it calls,
So that I can answer "how does this thing run a story?" without asking Claude to explain it.

**Acceptance Criteria:**

**Given** `plugins/sprint-orchestrator/README.md`,
**When** I read it,
**Then** it contains a section titled `## Story lifecycle` (or "Per-story workflow", or equivalent) with a code-block or mermaid diagram covering: `Pick → Claim → Implement (dev) → Review (reviewer) → Loop → Stop hook`.

**Given** the diagram,
**When** I scan it,
**Then** it labels the MCP tools called at each phase, at minimum: `getReadyStories`, `claimStory`, `getStoryContext`, `validateAcceptanceCriteria`, `commitStoryArtefacts`, and the three outbound `markStory*` tools.

**Given** Epic 1 has shipped (the diagram is added in Epic 3, after Epic 1),
**When** I read the diagram,
**Then** it shows the rework branch (`fail under cap` → back to Implement) — i.e. the diagram reflects the final shape including rework.

**And** `pnpm verify` exits zero.

