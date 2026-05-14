import { spawnSync } from "node:child_process";
import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { logStateMutation } from "../lib/run-log.js";
import { getOrInitConfig } from "./get-or-init-config.js";
import { type ToolContext } from "./context.js";

export interface PrepareStoryBranchResult {
  /**
   * The branch the orchestrator created and checked out, or `null` when the
   * tool was a no-op (pr_per_story is false, or no config could be loaded).
   */
  branch: string | null;
  /** True when the tool returned without touching git. */
  skipped: boolean;
  /** Reason for a skip, useful for debugging. Absent when branch was created. */
  reason?: string;
  /**
   * Human-readable explanation, populated alongside `reason` when the skip
   * is something the orchestrator skill should surface to the user (e.g.
   * `default_base-stale`).
   */
  message?: string;
}

/**
 * Slug a story title for use as the trailing portion of a branch name.
 *
 * Lowercases, replaces non-alphanumerics with single hyphens, trims leading
 * and trailing hyphens, and caps to 40 chars so the full branch name stays
 * comfortably short.
 */
export function slugify(title: string, maxLen = 40): string {
  const lower = title.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (replaced.length <= maxLen) return replaced;
  // Avoid a trailing hyphen produced by truncation.
  return replaced.slice(0, maxLen).replace(/-+$/, "");
}

export function buildBranchName(storyId: string, title: string): string {
  const idSlug = storyId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = slugify(title);
  if (!slug) return idSlug || `story-${storyId}`;
  return `${idSlug}-${slug}`;
}

function git(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

/**
 * Prepare a per-story branch ahead of the dev subagent. No-ops when
 * `pr_per_story` is false (or the config can't be loaded). When enabled,
 * creates `<id>-<slug>` from `default_base` and persists the branch on
 * `story.orchestrator.branch` so downstream tooling (push / PR open) can
 * read it back.
 *
 * Local-only: this tool never touches `origin` or `gh`. Pushing is a
 * later slice's job.
 */
export async function prepareStoryBranch(
  ctx: ToolContext,
  storyId: string,
  agentId: string,
): Promise<PrepareStoryBranchResult> {
  const cfgRes = await getOrInitConfig(ctx);
  if (!cfgRes.config) {
    return { branch: null, skipped: true, reason: "no-config" };
  }
  const cfg = cfgRes.config;
  if (cfg.pr_per_story === false) {
    return { branch: null, skipped: true, reason: "pr_per_story-disabled" };
  }
  const base = cfg.default_base ?? "main";

  // Note: the historical `default_base-stale` schema check (which inspected
  // `<base>:sprint-status.yaml` for a matching schema_version) was removed
  // when state moved out of git. Without state-on-branch the rationale —
  // avoiding per-branch schema divergence in the diff — no longer applies.

  // Read story (without yet acquiring write lock) to compute branch name.
  // We don't need to enforce claim ownership here — the skill only calls
  // this between claimStory and dev spawn, and a future double-call would
  // simply fail at `git checkout -b` because the branch already exists.
  // We still record `agentId` for traceability via the lock-held update below.
  const result = await updateSprintStatus<PrepareStoryBranchResult>(
    ctx.sprintStatusPath,
    async (state) => {
      const story = findStory(state, storyId);
      const branch = buildBranchName(storyId, story.title);

      // If the story has `depends_on`, prefer rooting the per-story branch at
      // the last completed dependency's branch tip rather than `default_base`.
      // This lets the dev subagent see its predecessor's commits — without us
      // having to merge anything. A chain (1 -> 2 -> 3) compounds: story 3
      // roots from story 2's tip which transitively contains story 1.
      //
      // We only chain when EVERY dep is done AND has a recorded
      // `orchestrator.branch` AND that branch still exists locally. Any miss
      // falls back to `default_base` and records the reason on the story.
      let chosenBase: string = base;
      let fallbackReason: string | null = null;
      if (Array.isArray(story.depends_on) && story.depends_on.length > 0) {
        const depMetas: Array<{
          id: string;
          branch: string;
          completedAt: string | undefined;
        }> = [];
        let chainable = true;
        for (const depId of story.depends_on) {
          const dep = state.stories.find((s) => s.id === depId);
          if (!dep) {
            chainable = false;
            fallbackReason = `dep ${depId} not found in sprint-status`;
            break;
          }
          if (dep.status !== "done") {
            chainable = false;
            fallbackReason = `dep ${depId} status=${dep.status} (not done)`;
            break;
          }
          const depBranch = (dep.orchestrator as Record<string, unknown>).branch;
          if (typeof depBranch !== "string" || depBranch.length === 0) {
            chainable = false;
            fallbackReason = `dep ${depId} has no orchestrator.branch (likely ran with pr_per_story=false)`;
            break;
          }
          const exists = git(ctx.projectRoot, ["rev-parse", "--verify", "--quiet", depBranch]);
          if (exists.status !== 0) {
            chainable = false;
            fallbackReason = `dep ${depId}'s branch '${depBranch}' no longer exists locally`;
            break;
          }
          const completedAt = (dep.orchestrator as Record<string, unknown>).completed_at;
          depMetas.push({
            id: depId,
            branch: depBranch,
            completedAt: typeof completedAt === "string" ? completedAt : undefined,
          });
        }
        if (chainable && depMetas.length > 0) {
          // Pick the most recently completed dep as the base. Ties (or missing
          // completed_at) fall back to insertion order, which matches the
          // story's declared `depends_on` ordering.
          const sorted = [...depMetas].sort((a, b) => {
            const ax = a.completedAt ?? "";
            const bx = b.completedAt ?? "";
            if (ax < bx) return -1;
            if (ax > bx) return 1;
            return 0;
          });
          chosenBase = sorted[sorted.length - 1]!.branch;
        }
      }

      // State no longer lives in git, so the historical sprint-status.yaml
      // revert-before-checkout dance is gone. The state file is in
      // `.sprint-orchestrator/state.yaml`, which `.gitignore` excludes; the
      // checkout is free of orchestrator interference.

      const checkout = git(ctx.projectRoot, ["checkout", "-b", branch, chosenBase]);
      if (checkout.status !== 0) {
        throw new Error(
          `prepareStoryBranch: git checkout -b ${branch} ${chosenBase} failed: ${checkout.stderr.trim()}`,
        );
      }

      const updatedOrch: typeof story.orchestrator = {
        ...story.orchestrator,
        branch,
        branch_prepared_by: agentId,
        branch_prepared_at: new Date().toISOString(),
        base_branch: chosenBase,
      };
      if (fallbackReason) {
        (updatedOrch as Record<string, unknown>).base_branch_fallback_reason = fallbackReason;
      } else {
        // Clear any stale reason from a prior attempt.
        delete (updatedOrch as Record<string, unknown>).base_branch_fallback_reason;
      }
      const updated = {
        ...story,
        orchestrator: updatedOrch,
      };
      return {
        next: replaceStory(state, updated),
        result: { branch, skipped: false },
      };
    },
  );
  if (result.branch) {
    await logStateMutation(ctx.projectRoot, {
      tool: "prepareStoryBranch",
      story_id: storyId,
      transition: "branch prepared",
      agent_id: agentId,
      extra: { branch: result.branch },
    });
  }
  return result;
}
