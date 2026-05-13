import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { type ToolContext } from "./context.js";

/**
 * Mark a story as `failed` with the supplied reason. Never retries silently;
 * the human (or a later run) decides what to do next.
 *
 * Note: `failed` means the orchestrator gave up on this story. It is distinct
 * from `blocked`, which is reserved for stories waiting on an external signal.
 *
 * @throws StoryNotFoundError, LockTimeoutError
 */
export async function markStoryFailed(
  ctx: ToolContext,
  storyId: string,
  reason: string,
): Promise<void> {
  await updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    const updated = {
      ...story,
      status: "failed" as const,
      orchestrator: {
        ...story.orchestrator,
        last_failure_reason: reason,
      },
    };
    return { next: replaceStory(state, updated), result: undefined };
  });
}
