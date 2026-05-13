import { spawnSync } from "node:child_process";
import * as YAML from "yaml";
import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { SCHEMA_VERSION } from "../state/schema.js";
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

  // Refuse early if `default_base` lags behind on the orchestrator schema
  // version. When the per-story branch is rooted at a stale base, every
  // state commit on the new branch diffs against the OLD schema and drags
  // along hundreds of lines of unrelated noise into the PR. Rebasing the
  // user's `default_base` would be a destructive surprise, so we surface
  // the mismatch and stop instead — see story 1 in the
  // pr-per-story-1-triage backlog for the full rationale.
  const headRef = git(ctx.projectRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const baseRef = git(ctx.projectRoot, ["rev-parse", base]).stdout.trim();
  if (baseRef && baseRef !== headRef) {
    const baseStatus = git(ctx.projectRoot, ["show", `${base}:sprint-status.yaml`]);
    if (baseStatus.status === 0) {
      let baseSchemaVersion: unknown;
      try {
        const parsed = YAML.parse(baseStatus.stdout) as { schema_version?: unknown } | null;
        baseSchemaVersion = parsed?.schema_version;
      } catch {
        baseSchemaVersion = undefined;
      }
      if (baseSchemaVersion !== SCHEMA_VERSION) {
        return {
          branch: null,
          skipped: true,
          reason: "default_base-stale",
          message:
            `default_base '${base}' is missing orchestrator schema version ${SCHEMA_VERSION} ` +
            `(found ${baseSchemaVersion === undefined ? "none" : String(baseSchemaVersion)}). ` +
            `Either rebase '${base}' onto your invocation branch or set default_base in ` +
            `.sprint-orchestrator/config.yaml.`,
        };
      }
    }
    // If `git show` failed (e.g. base does not yet have sprint-status.yaml
    // at all), fall through to the existing behaviour — `git checkout -b`
    // will surface any real problem with the base ref.
  }

  // Read story (without yet acquiring write lock) to compute branch name.
  // We don't need to enforce claim ownership here — the skill only calls
  // this between claimStory and dev spawn, and a future double-call would
  // simply fail at `git checkout -b` because the branch already exists.
  // We still record `agentId` for traceability via the lock-held update below.
  return updateSprintStatus<PrepareStoryBranchResult>(ctx.sprintStatusPath, async (state) => {
    const story = findStory(state, storyId);
    const branch = buildBranchName(storyId, story.title);

    // The caller (claimStory, just before us) has already written the new
    // claim into sprint-status.yaml. That uncommitted change can block a
    // plain `git checkout -b <branch> <base>` if base has a divergent copy
    // of the file (e.g. base=main while we're on a prior story branch that
    // committed sprint-status forward). We resolve this by reverting the
    // tracked sprint-status.yaml to the current branch's HEAD before the
    // checkout — the in-memory `next` state (with the new claim) will be
    // re-written to disk by updateSprintStatus once this mutator returns,
    // so no information is lost; it just lands on the per-story branch
    // instead of being a stray uncommitted hunk on the source branch.
    const dirty = git(ctx.projectRoot, ["status", "--porcelain", "sprint-status.yaml"]);
    if (dirty.stdout.trim().length > 0) {
      const restore = git(ctx.projectRoot, ["checkout", "--", "sprint-status.yaml"]);
      if (restore.status !== 0) {
        throw new Error(
          `prepareStoryBranch: failed to revert sprint-status.yaml before checkout: ${restore.stderr.trim()}`,
        );
      }
    }

    const checkout = git(ctx.projectRoot, ["checkout", "-b", branch, base]);
    if (checkout.status !== 0) {
      throw new Error(
        `prepareStoryBranch: git checkout -b ${branch} ${base} failed: ${checkout.stderr.trim()}`,
      );
    }

    const updated = {
      ...story,
      orchestrator: {
        ...story.orchestrator,
        branch,
        branch_prepared_by: agentId,
        branch_prepared_at: new Date().toISOString(),
      },
    };
    return {
      next: replaceStory(state, updated),
      result: { branch, skipped: false },
    };
  });
}
