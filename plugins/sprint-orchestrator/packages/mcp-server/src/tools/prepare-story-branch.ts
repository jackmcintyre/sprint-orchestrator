import { spawnSync } from "node:child_process";
import { findStory, replaceStory, updateSprintStatus } from "../state/sprint-status.js";
import { logStateMutation } from "../lib/run-log.js";
import { getOrInitConfig } from "./get-or-init-config.js";
import { type ToolContext } from "./context.js";
import { STALE_BRANCH_HAS_REAL_WORK_REFUSAL } from "./stale-branch-phrases.js";

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
 * Classify the commits on `branchRef` that are NOT on `baseRef`.
 *
 * Bookkeeping-only branches carry nothing but `chore(sprint):` and
 * `chore(ship-gate):` commits — both produced by orchestrator tooling, not
 * by the dev subagent. Those are safe to delete and recreate.
 *
 * If `branchRef` carries any other commit subject (typically a
 * `feat(<id>):` or `fix(<id>):` produced by the dev), the branch holds
 * unmerged human-meaningful work and must NOT be auto-deleted.
 *
 * `branchRef` and `baseRef` must both resolve in the given working tree.
 * The caller is responsible for fetching the remote first when inspecting
 * an `origin/<branch>` ref.
 */
export function classifyBranchCommits(
  cwd: string,
  branchRef: string,
  baseRef: string,
): { bookkeepingOnly: boolean; subjects: string[] } {
  const r = git(cwd, ["log", "--format=%s", `${baseRef}..${branchRef}`]);
  if (r.status !== 0) {
    // If git can't resolve the range, treat it as "has work" to fail safe —
    // we don't want to delete a branch we can't inspect.
    return { bookkeepingOnly: false, subjects: [] };
  }
  const subjects = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (subjects.length === 0) {
    // Zero commits ahead of base — definitionally bookkeeping-only (nothing
    // to lose by deleting and recreating).
    return { bookkeepingOnly: true, subjects: [] };
  }
  const isBookkeeping = (subject: string): boolean =>
    subject.startsWith("chore(sprint):") || subject.startsWith("chore(ship-gate):");
  const bookkeepingOnly = subjects.every(isBookkeeping);
  return { bookkeepingOnly, subjects };
}

/**
 * Does the local branch with this name exist?
 */
function localBranchExists(cwd: string, branch: string): boolean {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.status === 0;
}

/**
 * Does the remote-tracking branch `origin/<branch>` exist after a fetch?
 * Returns false when there is no `origin` remote at all.
 */
function remoteBranchExists(cwd: string, branch: string): boolean {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  return r.status === 0;
}

/**
 * Best-effort fetch of `origin/<branch>`. We deliberately swallow errors —
 * the branch may not exist on the remote, or there may be no remote at all
 * (the e2e harness exercises both). Callers re-check with
 * `remoteBranchExists` after this returns.
 */
function tryFetchRemoteBranch(cwd: string, branch: string): void {
  // Check origin is even configured before attempting to fetch.
  const remoteCheck = git(cwd, ["remote", "get-url", "origin"]);
  if (remoteCheck.status !== 0) return;
  git(cwd, ["fetch", "--quiet", "origin", branch]);
}

/**
 * Delete the local branch if it exists. Best-effort: returns silently if
 * the branch is missing or if the delete fails (callers re-check with
 * `localBranchExists` before continuing).
 */
function deleteLocalBranchIfExists(cwd: string, branch: string): void {
  if (!localBranchExists(cwd, branch)) return;
  git(cwd, ["branch", "-D", branch]);
}

/**
 * Delete the remote branch on origin if it exists. Best-effort.
 */
function deleteRemoteBranchIfExists(cwd: string, branch: string): void {
  if (!remoteBranchExists(cwd, branch)) return;
  git(cwd, ["push", "origin", "--delete", branch]);
}

/**
 * Combined cleanup helper used by `prepareStoryBranch` pre-flight AND by
 * `markStoryFailed` post-failure. Inspects local + remote refs for the
 * named branch. If both sides are bookkeeping-only (or absent), deletes
 * them and returns `{ cleaned: true }`. If either side carries real work,
 * returns `{ cleaned: false, reason: "has-real-work", subjects: [...] }`
 * so the caller can decide whether to refuse (prepareStoryBranch) or just
 * leave the branch in place (markStoryFailed).
 *
 * `chosenBase` is the base ref to diff against — typically the per-story
 * branch's recorded `base_branch`, falling back to `default_base`.
 */
export interface StaleBranchCleanupResult {
  cleaned: boolean;
  /** Set when `cleaned=false`. */
  reason?: "has-real-work";
  /** Subjects of the commits found ahead of base, across local and remote. */
  subjects: string[];
  /** Whether the local branch was present before we started. */
  hadLocal: boolean;
  /** Whether the remote branch was present before we started. */
  hadRemote: boolean;
}

export function cleanStaleBranchIfBookkeepingOnly(
  cwd: string,
  branch: string,
  chosenBase: string,
): StaleBranchCleanupResult {
  tryFetchRemoteBranch(cwd, branch);

  const hadLocal = localBranchExists(cwd, branch);
  const hadRemote = remoteBranchExists(cwd, branch);

  if (!hadLocal && !hadRemote) {
    return { cleaned: true, subjects: [], hadLocal, hadRemote };
  }

  const allSubjects: string[] = [];
  let anyRealWork = false;

  if (hadLocal) {
    const local = classifyBranchCommits(cwd, branch, chosenBase);
    allSubjects.push(...local.subjects);
    if (!local.bookkeepingOnly) anyRealWork = true;
  }
  if (hadRemote) {
    const remote = classifyBranchCommits(cwd, `origin/${branch}`, chosenBase);
    for (const s of remote.subjects) {
      if (!allSubjects.includes(s)) allSubjects.push(s);
    }
    if (!remote.bookkeepingOnly) anyRealWork = true;
  }

  if (anyRealWork) {
    return {
      cleaned: false,
      reason: "has-real-work",
      subjects: allSubjects,
      hadLocal,
      hadRemote,
    };
  }

  if (hadLocal) deleteLocalBranchIfExists(cwd, branch);
  if (hadRemote) deleteRemoteBranchIfExists(cwd, branch);
  return { cleaned: true, subjects: allSubjects, hadLocal, hadRemote };
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

      // Pre-flight: a prior failed run may have left a local or remote
      // branch with this exact name. If every commit on it is orchestrator
      // bookkeeping, auto-clean both sides so `checkout -b` doesn't blow up
      // with "branch already exists" and produce a 3-prompt human approval
      // dance (B9 in the orchestrator-bugs triage). If real `feat(<id>):` /
      // `fix(<id>):` commits are present, refuse with a phrase-locked
      // message so the human can decide whether to merge or discard.
      const headBefore = git(ctx.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
      if (headBefore === branch) {
        // HEAD is sitting on the very branch we want to recreate. Hop to
        // the base ref so the subsequent `branch -D` can run.
        const hop = git(ctx.projectRoot, ["checkout", "--quiet", chosenBase]);
        if (hop.status !== 0) {
          throw new Error(
            `prepareStoryBranch: could not hop off ${branch} to ${chosenBase} before cleanup: ${hop.stderr.trim()}`,
          );
        }
      }
      const cleanup = cleanStaleBranchIfBookkeepingOnly(ctx.projectRoot, branch, chosenBase);
      if (!cleanup.cleaned) {
        const subjectList = cleanup.subjects.map((s) => `  - ${s}`).join("\n");
        throw new Error(
          `${STALE_BRANCH_HAS_REAL_WORK_REFUSAL}\n\nBranch: ${branch}\nUnmerged commit subjects:\n${subjectList}`,
        );
      }

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
