import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { InvalidStateTransitionError } from "../lib/errors.js";
import { commitSprintState } from "../lib/commit-state.js";
import { type ToolContext } from "./context.js";

export interface RecordStoryReopenResult {
  status: "ready";
  reopened_at: string;
  reworkCount: number;
}

/**
 * Transition a `failed` story back to `ready` so the orchestrator can pick it
 * up again. Intended for human (or future supervisor agent) recovery — the
 * automated reviewer never calls this. Refuses on any non-`failed` status to
 * avoid being used as a free reset.
 *
 * Clears: `failed_at`, `last_failure_reason`, `claimed_by`, `claimed_at`.
 * Preserves: `rework_count` (audit), `last_review_feedback`, `notes`, any
 * `base_branch` / `branch` carried over from the prior run.
 * Appends one entry to `orchestrator.reopen_history` capturing the prior
 * failure reason and the supplied `reason` so the audit trail outlives the
 * reset.
 *
 * Persists the state mutation as `chore(sprint): reopen <id> — <reason>`.
 *
 * @throws StoryNotFoundError, InvalidStateTransitionError, LockTimeoutError
 */
export async function recordStoryReopen(
  ctx: ToolContext,
  storyId: string,
  reason: string,
): Promise<RecordStoryReopenResult> {
  const reopened_at = new Date().toISOString();
  const result = await updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    if (story.status !== "failed") {
      throw new InvalidStateTransitionError(storyId, story.status, "ready (reopen)");
    }

    const orchestrator = { ...story.orchestrator } as Record<string, unknown>;
    const priorFailureReason = orchestrator.last_failure_reason as string | undefined;

    delete orchestrator.failed_at;
    delete orchestrator.last_failure_reason;
    delete orchestrator.failure_details;
    delete orchestrator.claimed_by;
    delete orchestrator.claimed_at;

    const priorHistory = Array.isArray(orchestrator.reopen_history)
      ? (orchestrator.reopen_history as Array<Record<string, unknown>>)
      : [];
    orchestrator.reopen_history = [
      ...priorHistory,
      {
        reopened_at,
        reason,
        prior_status: "failed" as const,
        ...(priorFailureReason !== undefined ? { prior_failure_reason: priorFailureReason } : {}),
      },
    ];

    const reworkCount = (story.orchestrator.rework_count ?? 0) as number;

    const updated = {
      ...story,
      status: "ready" as const,
      orchestrator: orchestrator as typeof story.orchestrator,
    };

    return {
      next: replaceStory(state, updated),
      result: { reworkCount },
    };
  });

  await commitSprintState(ctx.projectRoot, `chore(sprint): reopen ${storyId} — ${reason}`);

  return { status: "ready", reopened_at, reworkCount: result.reworkCount };
}
