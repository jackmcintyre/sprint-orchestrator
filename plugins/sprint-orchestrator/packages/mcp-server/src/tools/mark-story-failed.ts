import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { logStateMutation } from "../lib/run-log.js";
import { DevNotReturnedError } from "../lib/errors.js";
import { type FailureDetail } from "../state/schema.js";
import { type ToolContext } from "./context.js";
import { cleanStaleBranchIfBookkeepingOnly } from "./prepare-story-branch.js";
import { getOrInitConfig } from "./get-or-init-config.js";

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

  // Captured inside the update callback so we can run branch cleanup after
  // the state transition commits. We need the per-story branch + the base
  // it was rooted from to decide whether the leftover is safe to delete.
  let branchToClean: string = "";
  let baseForCleanup: string = "";

  await updateSprintStatus(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    if (!story.orchestrator.dev_returned_at) {
      throw new DevNotReturnedError(storyId);
    }
    const orch = story.orchestrator as Record<string, unknown>;
    const branch = orch.branch;
    const baseBranch = orch.base_branch;
    if (typeof branch === "string" && branch.length > 0) {
      branchToClean = branch;
      baseForCleanup = typeof baseBranch === "string" && baseBranch.length > 0 ? baseBranch : "";
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

  // B9 cleanup: after a failure, the per-story branch is dead weight. Local
  // AND remote refs block the next attempt's prepareStoryBranch with
  // "branch already exists". Delete bookkeeping-only leftovers proactively;
  // leave anything with real feat/fix commits alone (a future
  // prepareStoryBranch will raise the same refusal so a human can triage).
  if (branchToClean) {
    const branchName: string = branchToClean;
    let base: string = baseForCleanup;
    if (!base) {
      // base_branch wasn't recorded — fall back to default_base from config.
      const cfgRes = await getOrInitConfig(ctx);
      base = cfgRes.config?.default_base ?? "main";
    }
    try {
      // If HEAD is currently on the branch we're about to delete, `git
      // branch -D` will refuse. Hop back to the base ref first.
      const { spawnSync } = await import("node:child_process");
      const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: ctx.projectRoot,
        encoding: "utf8",
      });
      const currentBranch = (head.stdout ?? "").trim();
      if (currentBranch === branchName) {
        spawnSync("git", ["checkout", "--quiet", base], {
          cwd: ctx.projectRoot,
          encoding: "utf8",
        });
      }
      cleanStaleBranchIfBookkeepingOnly(ctx.projectRoot, branchName, base);
    } catch {
      // Swallow — branch cleanup is best-effort; the failure transition has
      // already committed and we don't want to corrupt the state machine on
      // a git plumbing error.
    }
  }

  return { status: "failed", failed_at };
}
