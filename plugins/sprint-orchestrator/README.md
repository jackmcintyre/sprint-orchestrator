# sprint-orchestrator

A Claude Code plugin that turns sprint backlogs into autonomous-but-supervised execution. Deterministic state and guardrails live in TypeScript; the LLM only does the irreducibly fuzzy parts (implementation, review).

Works standalone or with BMAD v6 planning artefacts. When BMAD layout is detected, the plugin auto-configures; otherwise it asks once where your PRD / architecture / story files live.

## Status

**Phase 1 — skeleton.** Scaffolding only. Tools, hooks, and agents are stubs. See `project.md` for the full build spec.

## Quickstart

Install the plugin into Claude Code from this repo's marketplace:

```
/plugin marketplace add jackmcintyre/claude-dev-loop
/plugin install sprint-orchestrator
```

Then drive the backlog from inside Claude Code:

```
/sprint-orchestrator:process-backlog
```

To keep the orchestrator running on an interval (claiming and routing ready stories without manual nudging), wrap it in `/loop`:

```
/loop 5m /sprint-orchestrator:process-backlog
```

On first run in a project, the plugin asks where your planning docs live (or detects BMAD v6 layout automatically) and writes `.sprint-orchestrator/config.yaml`.

## Install from source

```bash
git clone <this-repo>
cd sprint-orchestrator
pnpm install
pnpm -r build
```

Then in Claude Code:

```
/plugin install <path-to-this-repo>
```

> **Heads-up — adding or renaming MCP tools requires a full Claude Code restart.** `/reload-plugins` reloads the MCP server but does not refresh Claude Code's deferred-tools registry, so newly registered tools (or renames) stay invisible until you exit and relaunch. If you upgrade this plugin and the orchestrator can't see a new tool, restart Claude Code.

## Story lifecycle

Each story moves through a deterministic pipeline. The orchestrator owns state transitions; LLM subagents only handle implementation and review.

```
                       getReadyStories
                              |
                              v
                        +-----------+
                        |   ready   |
                        +-----------+
                              |
                              | claimStory
                              v
                        +-------------+
                        | in_progress |  <-- dev subagent implements
                        +-------------+
                              |
                              | validateAcceptanceCriteria
                              v
                        +-------------+
                        |  validated  |
                        +-------------+
                              |
                              | commitStoryArtefacts
                              v
                        +-------------+
                        |  committed  |  <-- reviewer subagent inspects
                        +-------------+
                            /     \
            recordStorySuccess       recordStoryRework
                          /           \
                         v             v
                  +----------+    +-------------+
                  | complete |    |   ready     |  (re-queued with notes)
                  +----------+    +-------------+
```

Key transitions:

- `getReadyStories` — list unblocked stories whose dependencies are satisfied.
- `claimStory` — atomically reserve a story for one worker (prevents double-claims).
- `validateAcceptanceCriteria` — run the deterministic checks declared in the story spec.
- `commitStoryArtefacts` — stage and commit the implementation diff with a structured message.
- `recordStorySuccess` — finalize a story after reviewer approval (formerly `markStoryComplete`).
- `recordStoryRework` — bounce a story back for another attempt with reviewer feedback attached (formerly `markStoryNeedsRework`).
- `recordStoryFailure` — give up on a story with a structured reason (formerly `markStoryFailed`).

## Modes

- **One-shot supervised** — install in Claude Code, run the slash command, watch it process up to 5 ready stories, and stop.
- **Recurring unattended (still inside Claude Code)** — keep a Claude Code session open and run `/loop 30m /sprint-orchestrator:process-backlog`. The orchestrator re-fires every 30 minutes, draining ready stories as they become available. Uses your existing Claude Code auth (Max / Pro / API key) — no separate runner needed.

## Development

```bash
pnpm -r build       # compile all packages
pnpm -r test        # vitest
pnpm -r typecheck   # tsc --noEmit
pnpm lint           # eslint
```

## Writing acceptance criteria

Acceptance criteria (`acceptance_criteria.checks` in `sprint-status.yaml`) are
the deterministic gate between "dev says done" and "story is committed". They
are only as strong as you make them — a single literal-grep is trivially
satisfiable by an agent that decides to write the matching string into a file.

Guidance:

- **Layer multiple checks.** Combine regex/shell assertions with a real build
  or test invocation. A typical story should have at least one structural check
  (regex/file-exists) plus one behavioural check (`pnpm verify`, `pnpm test`,
  `tsc --noEmit`, etc.). The whole list must pass.
- **Avoid bare literal greps as the sole criterion.** `grep "TODO done"` proves
  nothing. Prefer regex patterns that anchor to real code shapes
  (function/export signatures, config keys, route paths) and back them with a
  command that exercises the behaviour.
- **For genuinely-impossible or "do not implement" stories**, use an
  unreachable assertion such as `shell: "false"` or a check that asserts the
  absence of forbidden patterns. Do not rely on a passing-by-default check.
- **Prefer `expect_exit: 0` shell checks** for anything that has a real test
  harness — they fail loudly when the code regresses, unlike a regex that may
  silently still match.

## Hand-editing sprint-status.yaml

`sprint-status.yaml` is the canonical state file, but it is not the only source
of truth the orchestrator relies on — every transition the orchestrator
performs is also appended to `.sprint-orchestrator/run.log`. Direct edits to
`sprint-status.yaml` (or reverts via `git checkout`) bypass `run.log`
entirely.

This is fine for occasional repair (unsticking a stale claim, fixing a typo in
a story spec), but be aware:

- `run.log` will be **incomplete** for any span where state changed out of
  band. Audit trails, retrospectives, and any tooling that reconstructs
  history from the log will see a gap.
- If you revert `sprint-status.yaml` after a bad run, the log still contains
  the now-orphaned transitions. Consider annotating the log manually, or
  truncating it alongside the revert if you need a clean baseline.
- Prefer the orchestrator's tools (`releaseStaleClaims`, `recordStoryFailure`,
  etc.) over hand edits whenever an equivalent tool exists — they keep state
  and log in sync.

## Known issue: orphan code commit on state-write failure

The reviewer's flow is `validateAcceptanceCriteria → commitStoryArtefacts → recordStorySuccess`. If the final `recordStorySuccess` call fails for any reason (file lock, schema validation error, harness classifier intercepts), the code commit produced by `commitStoryArtefacts` has already landed on the branch with no matching state commit. The state machine is split between the working tree (committed) and `sprint-status.yaml` (still `in_progress`).

Recovery (4 steps):

1. Hand-edit `sprint-status.yaml`: set the story's `status: ready` and clear `claimed_by` / `claimed_at`.
2. Re-run `/sprint-orchestrator:process-backlog`. The reviewer will re-validate and complete the state transition.
3. Verify by calling `getSprintStatus` (via MCP) — confirm the story is now `status: done` with a fresh `completed_at`.
4. The orphan code commit from before the failure is real and stays in history. Reverting it will undo the work; leave it unless you know you want it gone.

A future sprint will replace this with proper atomic commit-and-mark or rollback-on-failure semantics. Until then, this is the documented workaround.

## License

MIT
