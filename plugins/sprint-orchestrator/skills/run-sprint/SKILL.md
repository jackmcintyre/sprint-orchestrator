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
3. (Removed.) The historical uncommitted-backlog preflight is obsolete: orchestrator state now lives at `.sprint-orchestrator/state.yaml` (gitignored), so the backlog cannot be dirty-in-git in the first place.
4. Read `CWD/sprint-status.yaml`. Count `stories[]` as `N`.
5. If `N > 0` and every story has `status: done` or `status: failed`, refuse with exactly: `nothing to run — backlog is drained. Stories: <D> done, <F> failed.` Do NOT invoke `/goal`. Stop.
6. Read `turn_cap_per_story` from `CWD/.sprint-orchestrator/config.yaml`. If the file or field is missing, use the default `3`. (Default matches the per-story worst case under the current rework cap of 2: dev + reviewer + one rework dev + reviewer, rounded up.)
7. Compute `turn_cap = ceil(N * turn_cap_per_story)`.
8. Print any short narrative / summary lines you want the user to see (e.g. "3 stories detected, turn cap = 9"). Keep it brief — one or two lines at most.
9. Print a single blank line as a visual separator.
10. Print the locked final block — exactly two lines, in this order, with nothing after them:

   ```
   Paste this in a fresh context window for the cleanest run:
   /goal /sprint-orchestrator:process-backlog UNTIL every story in sprint-status.yaml is status=done or status=failed, OR stop after <turn_cap> turns
   ```

   Substitute `<turn_cap>` with the computed integer. No other changes.

   **Hard rules for the final block:**
   - The `/goal ...` line is the LITERAL LAST LINE of stdout. Nothing — no summary, no trailing prose, no extra blank line beyond a single `\n` — appears after it.
   - The `/goal ...` line is a single physical line. Do not soft-wrap it, do not break it across lines, do not indent it.
   - The line immediately above the `/goal` line is the fresh-context guidance string above, verbatim.

   Why fresh-context-window matters: a clean transcript gives `/goal` a clean signal to evaluate the drain condition against, free of prior conversation noise. Treat copy-paste into a new window as the recommended path, not a chore.

## Implementation note

A reference implementation of steps 2–7 lives in `packages/mcp-server/src/tools/plan-run-sprint.ts` (`planRunSprint`). The locked final-block strings (fresh-context guidance + `/goal` line) are defined in `packages/mcp-server/src/tools/run-sprint-output-format.ts` — `FRESH_CONTEXT_GUIDANCE_LINE`, `formatGoalCommandLine(turnCap)`, and `buildRunSprintFinalOutput(turnCap)`. The e2e harness asserts on those constants directly, so the wrapper's emitted output and the documented contract are the same string by construction. If you (the LLM running this skill) need the final block deterministically, call `buildRunSprintFinalOutput(turn_cap)` and print its return value as-is at the end of stdout.

## Rules

- Zero other logic. No story selection, no claim, no review. Hand off to `/goal` and stop.
- Never invent acceptance criteria, never call MCP tools, never edit `sprint-status.yaml`.
- Existing invocation paths (`/sprint-orchestrator:process-backlog` direct, `/loop 5m ...`, raw `/goal ...`) keep working unchanged. This wrapper is additive convenience only.
