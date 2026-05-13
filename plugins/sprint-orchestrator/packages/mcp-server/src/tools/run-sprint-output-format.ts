/**
 * Locked output format for the `/sprint-orchestrator:run-sprint` wrapper.
 *
 * The wrapper computes a turn cap and prints a canonical `/goal` command
 * for the user to copy. To make that copy-paste trivial — and to keep the
 * skill and the e2e harness from drifting — we lock the final two lines
 * of run-sprint's stdout in this module:
 *
 *   - second-to-last non-empty line: FRESH_CONTEXT_GUIDANCE_LINE
 *   - last line: the exact /goal command, on a single line, with nothing
 *     after it except at most one trailing newline.
 *
 * Same discipline as `format-end-of-run-line.ts` and
 * `readme-adopt-phrases.ts` from prior sprints: constants here, e2e
 * asserts on them directly, SKILL.md references them so prose and
 * behaviour stay in lockstep.
 */
import { buildGoalCommand } from "./plan-run-sprint.js";

/**
 * One-line, user-facing note printed immediately above the /goal command.
 * Tells the user the cleanest place to paste it is a fresh context window
 * — a fresh transcript gives /goal a clean signal to evaluate the drain
 * condition against, free of prior conversation noise.
 */
export const FRESH_CONTEXT_GUIDANCE_LINE =
  "Paste this in a fresh context window for the cleanest run:";

/**
 * The canonical /goal command for the wrapper, as a single line.
 *
 * Delegates to `buildGoalCommand` from plan-run-sprint so the wrapper,
 * the planner, and the e2e share one source of truth for the drain
 * condition wording. Re-exported here as `formatGoalCommandLine` so the
 * intent ("this is the literal last line of run-sprint's output") is
 * obvious at the call site.
 */
export function formatGoalCommandLine(turnCap: number): string {
  return buildGoalCommand(turnCap);
}

/**
 * Assemble the locked last-two-lines block that run-sprint MUST emit at
 * the end of its stdout. The block is intentionally returned with no
 * leading newline (the caller is expected to print a blank line above it
 * to separate from any preceding narrative) and exactly one trailing
 * newline (so the /goal line is the final non-empty line of output).
 *
 * Contract:
 *   - the last line of the returned string (after stripping the single
 *     trailing newline) is `formatGoalCommandLine(turnCap)` verbatim;
 *   - the second-to-last non-empty line is `FRESH_CONTEXT_GUIDANCE_LINE`;
 *   - the /goal line contains no embedded newlines (it is one physical
 *     line, no soft-wrap concerns for callers that respect the contract);
 *   - nothing appears after the /goal line except at most one trailing
 *     `\n`.
 */
export function buildRunSprintFinalOutput(turnCap: number): string {
  return `${FRESH_CONTEXT_GUIDANCE_LINE}\n${formatGoalCommandLine(turnCap)}\n`;
}
