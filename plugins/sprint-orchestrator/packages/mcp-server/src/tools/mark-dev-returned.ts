import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { logStateMutation } from "../lib/run-log.js";
import { type ToolContext } from "./context.js";

export interface MarkDevReturnedResult {
  dev_returned_at: string;
}

/**
 * Persist `orchestrator.dev_returned_at` for a story so the reviewer knows
 * the dev subagent has completed its swing. `recordStoryFailure` and
 * `validateAcceptanceCriteria` refuse when this timestamp is absent, acting
 * as a backstop against the reviewer evaluating ACs before any dev work
 * has happened (which caused spurious failures within 30 s of claimStory).
 *
 * The dev subagent calls this tool immediately before returning its summary
 * to the orchestrator.
 *
 * @throws StoryNotFoundError, LockTimeoutError
 */
export async function markDevReturned(
  ctx: ToolContext,
  storyId: string,
  agentId: string,
): Promise<MarkDevReturnedResult> {
  const dev_returned_at = new Date().toISOString();
  await updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    const updated = {
      ...story,
      orchestrator: {
        ...story.orchestrator,
        dev_returned_at,
      },
    };
    return { next: replaceStory(state, updated), result: undefined };
  });
  await logStateMutation(ctx.projectRoot, {
    tool: "markDevReturned",
    story_id: storyId,
    transition: "dev_returned_at set",
    agent_id: agentId,
    extra: { dev_returned_at },
  });
  return { dev_returned_at };
}
