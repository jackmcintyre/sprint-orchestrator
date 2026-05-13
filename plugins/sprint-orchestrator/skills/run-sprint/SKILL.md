---
name: run-sprint
description: Thin wrapper that reads sprint-status.yaml in the cwd, computes a turn cap from story count, and invokes /goal with the canonical drain condition so the user doesn't have to type the boilerplate.
user-invocable: true
allowed-tools:
  - "Bash"
  - "Read"
---

You are a thin entrypoint. You do not orchestrate stories yourself — `/sprint-orchestrator:process-backlog` does that. Your job is to assemble the right `/goal` invocation and hand it off.

## Steps (run once per invocation)

1. Resolve the user's working directory (the directory they invoked the wrapper from). Call it `CWD`.
2. Check that `CWD/sprint-status.yaml` exists. If it does NOT:
   - Refuse with exactly: `no backlog found: expected sprint-status.yaml at <CWD>/sprint-status.yaml. Copy a backlog file there before running.`
   - Do NOT invoke `/goal`. Stop.
3. Read `CWD/sprint-status.yaml`. Count `stories[]` as `N`.
4. If `N > 0` and every story has `status: done` or `status: failed`, refuse with exactly: `nothing to run — backlog is drained. Stories: <D> done, <F> failed.` Do NOT invoke `/goal`. Stop.
5. Read `turn_cap_per_story` from `CWD/.sprint-orchestrator/config.yaml`. If the file or field is missing, use the default `3`. (Default matches the per-story worst case under the current rework cap of 2: dev + reviewer + one rework dev + reviewer, rounded up.)
6. Compute `turn_cap = ceil(N * turn_cap_per_story)`.
7. Emit the `/goal` invocation, verbatim:

   ```
   /goal /sprint-orchestrator:process-backlog UNTIL every story in sprint-status.yaml is status=done or status=failed, OR stop after <turn_cap> turns
   ```

   Substitute `<turn_cap>` with the computed integer. No other changes.

## Implementation note

A reference implementation of steps 2–7 lives in `packages/mcp-server/src/tools/plan-run-sprint.ts` (`planRunSprint`). The e2e harness imports it directly, so the wrapper's emitted command and the planner's output are the same string by construction. If you (the LLM running this skill) need to compute the cap deterministically, call that module — otherwise the inline algorithm above is sufficient.

## Rules

- Zero other logic. No story selection, no claim, no review. Hand off to `/goal` and stop.
- Never invent acceptance criteria, never call MCP tools, never edit `sprint-status.yaml`.
- Existing invocation paths (`/sprint-orchestrator:process-backlog` direct, `/loop 5m ...`, raw `/goal ...`) keep working unchanged. This wrapper is additive convenience only.
