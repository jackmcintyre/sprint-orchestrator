/**
 * Canonical end-of-run summary lines emitted by the
 * `/sprint-orchestrator:process-backlog` skill.
 *
 * Three distinct, greppable line shapes let the /goal evaluator (a
 * Haiku-class model reading the transcript) disambiguate at a glance
 * between a clean drain, a hard-cap pause, and a blocked stop. The
 * exact grammar is the contract — future narrative tweaks around it
 * are fine, but these strings must not drift.
 *
 * The skill's SKILL.md instructs Claude to emit these lines verbatim;
 * this module is the reference implementation the e2e harness imports
 * directly so the asserted output and the documented contract are the
 * same string by construction.
 */
import { readSprintStatus } from "../state/sprint-status.js";

/**
 * Drain: main loop exited because getReadyStories returned [].
 * The final printed line MUST be exactly this string.
 */
export function formatDrainLine(done: number, failed: number): string {
  return `Sprint drain confirmed: 0 ready stories remaining. Outcome: ${done} done, ${failed} failed.`;
}

/**
 * Cap-stop: main loop exited because the 5-story hard cap was hit
 * (not drain). K = ready stories still remaining; D/F = outcome so far.
 */
export function formatCapStopLine(readyRemaining: number, done: number, failed: number): string {
  return `Sprint paused at hard cap: ${readyRemaining} ready stories remaining. Outcome so far: ${done} done, ${failed} failed.`;
}

/**
 * Blocked: main loop exited because the reviewer returned
 * `blocked: ...` (state-machine rejection). Reason is the verbatim
 * tail from the reviewer's blocked line.
 */
export function formatBlockedLine(reason: string, readyRemaining: number): string {
  return `Sprint blocked: ${reason}. ${readyRemaining} ready stories remaining.`;
}

/**
 * Convenience: read sprint-status.yaml at the given path and count
 * stories in each terminal status. The skill should call this (or
 * replicate its logic) immediately before emitting the drain / cap-stop
 * lines, so D/F reflect the on-disk state at end of run.
 */
export async function countTerminalOutcomes(
  sprintStatusPath: string,
): Promise<{ done: number; failed: number }> {
  const sprint = await readSprintStatus(sprintStatusPath);
  const done = sprint.stories.filter((s) => s.status === "done").length;
  const failed = sprint.stories.filter((s) => s.status === "failed").length;
  return { done, failed };
}
