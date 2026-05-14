import { spawnSync } from "node:child_process";
import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import {
  AcceptanceFailedError,
  ClaimConflictError,
  InvalidStateTransitionError,
} from "../lib/errors.js";
import { commitSprintState } from "../lib/commit-state.js";
import { runChecks } from "../validators/acceptance.js";
import { getOrInitConfig } from "./get-or-init-config.js";
import { type ToolContext } from "./context.js";

export interface MarkStoryCompleteResult {
  status: "done";
  completed_at: string;
}

export interface PrPerStoryRefusalResult {
  ok: false;
  reason: "pr_per_story_requires_pushed_pr";
  details: {
    branch: string;
    missing: Array<"push" | "pr">;
  };
}

function git(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function gh(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

/**
 * When pr_per_story is true, verify that:
 *  1. The branch has been pushed to origin AND its tip matches local HEAD.
 *  2. At least one open PR exists for the branch on GitHub.
 *
 * Returns a refusal result if either check fails, or null if all checks pass
 * (or pr_per_story is false / no branch is recorded).
 */
async function checkPrPerStory(
  ctx: ToolContext,
  branch: string | undefined,
): Promise<PrPerStoryRefusalResult | null> {
  const cfgRes = await getOrInitConfig(ctx);
  if (!cfgRes.config || cfgRes.config.pr_per_story !== true) {
    return null;
  }
  if (!branch) {
    return null;
  }

  const missing: Array<"push" | "pr"> = [];

  // Push check: origin/<branch> must exist and equal local <branch>
  const localSha = git(ctx.projectRoot, ["rev-parse", branch]).stdout.trim();
  const originSha = git(ctx.projectRoot, ["rev-parse", `origin/${branch}`]).stdout.trim();
  if (!originSha || originSha !== localSha) {
    missing.push("push");
  }

  // PR check: gh pr list --head <branch> must return at least one entry
  const prList = gh(ctx.projectRoot, ["pr", "list", "--head", branch, "--json", "number,state"]);
  let hasPr = false;
  if (prList.status === 0) {
    try {
      const parsed = JSON.parse(prList.stdout) as unknown[];
      hasPr = Array.isArray(parsed) && parsed.length > 0;
    } catch {
      hasPr = false;
    }
  }
  if (!hasPr) {
    missing.push("pr");
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: "pr_per_story_requires_pushed_pr",
      details: { branch, missing },
    };
  }
  return null;
}

/**
 * Mark a story as `done`. Validates that:
 *   - the caller (`agentId`) is the current claim holder
 *   - the story is currently `in_progress`
 *   - acceptance criteria pass (re-run inside the lock)
 *
 * Returns the new status + completion timestamp so MCP callers can surface
 * them in their replies (the reviewer subagent uses this to enrich its
 * one-line return).
 *
 * @throws ClaimConflictError, InvalidStateTransitionError, AcceptanceFailedError
 */
export async function markStoryComplete(
  ctx: ToolContext,
  storyId: string,
  agentId: string,
  summary: string,
  artefacts: string[] = [],
): Promise<MarkStoryCompleteResult | PrPerStoryRefusalResult> {
  let completed_at = "";

  // Pre-flight: if pr_per_story is enabled, the branch must be pushed and a PR
  // must exist before we allow the story to be marked done. Read the branch from
  // the story orchestrator metadata (set by prepareStoryBranch).
  {
    const { stories } = await import("../state/sprint-status.js").then(async (m) =>
      m.readSprintStatus(ctx.sprintStatusPath),
    );
    const preStory = stories.find((s) => s.id === storyId);
    const branch = preStory?.orchestrator?.branch as string | undefined;
    const refusal = await checkPrPerStory(ctx, branch);
    if (refusal) return refusal;
  }

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

    completed_at = new Date().toISOString();
    const updated = {
      ...story,
      status: "done" as const,
      orchestrator: {
        ...story.orchestrator,
        completed_at,
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

  return { status: "done", completed_at };
}
