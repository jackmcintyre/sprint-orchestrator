import { replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { logStateMutation } from "../lib/run-log.js";
import { type ToolContext } from "./context.js";

/**
 * Reset to `ready` any story currently `in_progress` whose claim is older
 * than `olderThanMinutes`. Returns the affected story IDs.
 *
 * For recovering from agents that crashed mid-story.
 */
export async function releaseStaleClaims(
  ctx: ToolContext,
  olderThanMinutes: number,
): Promise<string[]> {
  const cutoff = Date.now() - olderThanMinutes * 60_000;
  const released = await updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const released: string[] = [];
    let next = state;
    for (const story of state.stories) {
      if (story.status !== "in_progress") continue;
      const claimedAt = story.orchestrator.claimed_at;
      if (!claimedAt) continue;
      const ts = Date.parse(claimedAt);
      if (Number.isNaN(ts) || ts > cutoff) continue;
      released.push(story.id);
      const rest = { ...story.orchestrator };
      delete rest.claimed_by;
      delete rest.claimed_at;
      next = replaceStory(next, {
        ...story,
        status: "ready",
        orchestrator: rest,
      });
    }
    return { next, result: released };
  });
  for (const storyId of released) {
    await logStateMutation(ctx.projectRoot, {
      tool: "releaseStaleClaims",
      story_id: storyId,
      transition: "in_progress→ready",
      reason: `claim older than ${olderThanMinutes} min`,
    });
  }
  return released;
}
