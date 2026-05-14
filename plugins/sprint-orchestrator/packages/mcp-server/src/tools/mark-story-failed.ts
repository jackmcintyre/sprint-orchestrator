import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { logStateMutation } from "../lib/run-log.js";
import { DevNotReturnedError } from "../lib/errors.js";
import { type FailureDetail } from "../state/schema.js";
import { type ToolContext } from "./context.js";

export type { FailureDetail };

export interface MarkStoryFailedResult {
  status: "failed";
  failed_at: string;
}

/**
 * Derive a human-readable summary from structured failure details.
 * Falls back to `reason` when no details are present.
 */
function deriveFailureReason(details: FailureDetail[], fallback: string): string {
  const first = details[0];
  if (!first) return fallback;
  return `AC failed: \`${first.cmd}\` exited ${first.exit_code}, expected ${first.expected_exit}`;
}

/**
 * Mark a story as `failed` with the supplied reason. Never retries silently;
 * the human (or a later run) decides what to do next.
 *
 * Note: `failed` means the orchestrator gave up on this story. It is distinct
 * from `blocked`, which is reserved for stories waiting on an external signal.
 *
 * Returns the new status + failure timestamp so MCP callers can surface them
 * in their replies.
 *
 * @throws StoryNotFoundError, LockTimeoutError
 */
export async function markStoryFailed(
  ctx: ToolContext,
  storyId: string,
  reason: string,
  failureDetails?: FailureDetail[],
): Promise<MarkStoryFailedResult> {
  const failed_at = new Date().toISOString();
  const details = failureDetails ?? [];
  const last_failure_reason = deriveFailureReason(details, reason);

  await updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    if (!story.orchestrator.dev_returned_at) {
      throw new DevNotReturnedError(storyId);
    }
    const orchestratorUpdate = {
      ...story.orchestrator,
      last_failure_reason,
      failed_at,
      ...(details.length > 0 ? { failure_details: details } : {}),
    };
    const updated = {
      ...story,
      status: "failed" as const,
      orchestrator: orchestratorUpdate,
    };
    return { next: replaceStory(state, updated), result: undefined };
  });

  await logStateMutation(ctx.projectRoot, {
    tool: "recordStoryFailure",
    story_id: storyId,
    transition: "in_progress→failed",
    reason: last_failure_reason,
    extra: { failed_at },
  });

  return { status: "failed", failed_at };
}
