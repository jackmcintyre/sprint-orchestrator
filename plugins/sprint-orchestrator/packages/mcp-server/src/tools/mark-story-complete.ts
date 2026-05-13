import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import {
  AcceptanceFailedError,
  ClaimConflictError,
  InvalidStateTransitionError,
} from "../lib/errors.js";
import { commitSprintState } from "../lib/commit-state.js";
import { runChecks } from "../validators/acceptance.js";
import { type ToolContext } from "./context.js";

/**
 * Mark a story as `done`. Validates that:
 *   - the caller (`agentId`) is the current claim holder
 *   - the story is currently `in_progress`
 *   - acceptance criteria pass (re-run inside the lock)
 *
 * @throws ClaimConflictError, InvalidStateTransitionError, AcceptanceFailedError
 */
export async function markStoryComplete(
  ctx: ToolContext,
  storyId: string,
  agentId: string,
  summary: string,
  artefacts: string[] = [],
): Promise<void> {
  await updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    if (story.status !== "in_progress") {
      throw new InvalidStateTransitionError(storyId, story.status, "done");
    }
    const holder = story.orchestrator.claimed_by;
    if (holder !== agentId) {
      throw new ClaimConflictError(storyId, agentId, holder);
    }

    const result = await runChecks(story.acceptance_criteria.checks, { cwd: ctx.projectRoot });
    if (!result.passed) {
      throw new AcceptanceFailedError(
        storyId,
        result.results.filter((r) => !r.passed),
      );
    }

    const updated = {
      ...story,
      status: "done" as const,
      orchestrator: {
        ...story.orchestrator,
        completed_at: new Date().toISOString(),
        summary,
        ...(artefacts.length > 0 ? { artefacts } : {}),
      },
    };
    return { next: replaceStory(state, updated), result: undefined };
  });

  // Persist the state mutation as its own `git commit` (touching ONLY
  // sprint-status.yaml) so reverting a code commit does not roll back the
  // orchestrator state machine. Idempotent: no-op when sprint-status.yaml is
  // already clean (e.g. updateSprintStatus produced no textual diff).
  await commitSprintState(ctx.projectRoot, `chore(sprint): persist ${storyId} completion`);
}
