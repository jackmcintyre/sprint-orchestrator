import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { ClaimConflictError, InvalidStateTransitionError } from "../lib/errors.js";
import { type ToolContext } from "./context.js";

/**
 * Default rework cap. When `rework_count` reaches this value the response
 * carries `capReached: true` so the reviewer can decide to flip the story to
 * `blocked` via `markStoryFailed`. This tool itself never changes status —
 * the story stays `in_progress` with `claimed_by` unchanged so the same dev
 * can take another swing.
 */
export const DEFAULT_REWORK_LIMIT = 2;

export interface MarkStoryNeedsReworkResult {
  reworkCount: number;
  capReached: boolean;
}

/**
 * Record a failed-review attempt against a claimed, in-progress story.
 *
 * Increments `rework_count`, stores the reviewer's `reason` as
 * `last_review_feedback`, and stamps `last_review_at`. Status and claim are
 * left alone — only the reviewer (via a separate `markStoryFailed` call)
 * decides when to give up.
 *
 * @throws StoryNotFoundError, ClaimConflictError, InvalidStateTransitionError,
 *   LockTimeoutError
 */
export async function markStoryNeedsRework(
  ctx: ToolContext,
  storyId: string,
  agentId: string,
  reason: string,
  reworkLimit: number = DEFAULT_REWORK_LIMIT,
): Promise<MarkStoryNeedsReworkResult> {
  return updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    if (story.status !== "in_progress") {
      throw new InvalidStateTransitionError(storyId, story.status, "in_progress (rework)");
    }
    const holder = story.orchestrator.claimed_by;
    if (holder !== agentId) {
      throw new ClaimConflictError(storyId, agentId, holder);
    }

    const previousCount = story.orchestrator.rework_count ?? 0;
    const reworkCount = previousCount + 1;
    const capReached = reworkCount >= reworkLimit;

    const updated = {
      ...story,
      orchestrator: {
        ...story.orchestrator,
        rework_count: reworkCount,
        last_review_feedback: reason,
        last_review_at: new Date().toISOString(),
      },
    };

    return {
      next: replaceStory(state, updated),
      result: { reworkCount, capReached },
    };
  });
}
