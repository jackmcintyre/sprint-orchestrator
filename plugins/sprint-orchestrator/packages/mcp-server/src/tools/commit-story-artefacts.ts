import { spawn } from "node:child_process";
import { findStory, readSprintStatus } from "../state/sprint-status.js";
import { type Story } from "../state/schema.js";
import { type ToolContext } from "./context.js";
import { getOrInitConfig } from "./get-or-init-config.js";
import { shipGateEmptyCommitMessage } from "./ship-gate-phrases.js";

export interface CommitResult {
  sha: string | null;
}

/**
 * Pathspec exclusions applied to every `git add` / `git status` invocation
 * inside `commitStoryArtefacts`. Built-in defaults so the tool stays clean
 * even in repos whose `.gitignore` is missing or incomplete:
 *
 * - `sprint-status.yaml` — legacy on-disk state location (the canonical
 *   file moved to `.sprint-orchestrator/state.yaml`, which is gitignored).
 *   Kept in the exclusion list as a belt-and-braces guard: if a stale
 *   pre-migration copy still exists in the working tree, we will not
 *   re-commit it.
 * - `.sprint-orchestrator/` — runtime artefacts (run.log, locks, etc.)
 *   produced by hooks; never code.
 * - `.claude/` — Claude Code's local harness state (settings.local.json,
 *   scheduled_tasks.lock, …).
 * - `**\/.DS_Store` — macOS finder noise at any depth.
 * - `node_modules/` — package install output; should always be gitignored
 *   but real-world repos sometimes forget.
 *
 * NOTE: this is the "option A" minimal-default approach. A future story may
 * switch to an explicit artefact allowlist driven off
 * `story.orchestrator.artefacts`. Until then this tool relies on the user's
 * own `.gitignore` for any further cleanliness beyond the defaults above.
 */
const PATHSPEC_EXCLUSIONS = [
  ":!sprint-status.yaml",
  ":(exclude,glob)**/.sprint-orchestrator",
  ":(exclude,glob)**/.sprint-orchestrator/**",
  ":(exclude,glob)**/.claude",
  ":(exclude,glob)**/.claude/**",
  ":(exclude,glob)**/.DS_Store",
  ":(exclude,glob)**/node_modules",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/dist",
  ":(exclude,glob)**/dist/**",
];

/**
 * Stage and commit the working tree as the result of completing one story.
 *
 * - Runs `git add -A` (with the {@link PATHSPEC_EXCLUSIONS} applied) and
 *   `git commit -m "feat(<storyId>): <title>"` with a
 *   `Co-authored-by: Claude` trailer.
 * - Returns `{ sha: null }` when there are no changes to commit (legitimate
 *   for stories that only changed metadata) — callers should treat that as
 *   a non-error.
 *
 * @throws StoryNotFoundError, StateNotFoundError, StateParseError
 */
export async function commitStoryArtefacts(
  ctx: ToolContext,
  storyId: string,
): Promise<CommitResult> {
  const state = await readSprintStatus(ctx.sprintStatusPath);
  const story = findStory(state, storyId);

  await run(ctx.projectRoot, "git", ["add", "-A", "--", ".", ...PATHSPEC_EXCLUSIONS]);
  const status = await capture(ctx.projectRoot, "git", [
    "status",
    "--porcelain",
    "--",
    ".",
    ...PATHSPEC_EXCLUSIONS,
  ]);
  if (!status.stdout.trim()) {
    // No working-tree changes. Under `pr_per_story: true`, a per-story
    // branch with zero commits ahead of its base produces a "No commits
    // between <base> and <branch>" error from `gh pr create`. That hard-
    // wedges any verification-only ship-gate story. Detect that case
    // structurally (clean tree + zero commits ahead of recorded
    // `base_branch`) and lay down one empty commit so the push + PR
    // can proceed.
    const empty = await maybeLayDownShipGateEmptyCommit(ctx, story);
    return { sha: empty };
  }

  const message = `feat(${story.id}): ${story.title}`;
  const r = await run(ctx.projectRoot, "git", [
    "commit",
    "-m",
    message,
    "--trailer",
    "Co-authored-by: Claude <noreply@anthropic.com>",
  ]);
  if (r.exitCode !== 0) return { sha: null };

  const sha = await capture(ctx.projectRoot, "git", ["rev-parse", "HEAD"]);
  return { sha: sha.stdout.trim() || null };
}

/**
 * Ship-gate fallback: if `pr_per_story` is on AND the per-story branch
 * has zero commits ahead of `config.default_base`, lay down one empty
 * commit so `git push -u origin <branch>` + `gh pr create` can succeed.
 * Returns the new commit's sha or `null` when no empty commit was
 * created (any precondition unmet, or git refused).
 *
 * Trigger is structural — name-agnostic — so any verification-only
 * story (not just ones titled "ship gate") benefits.
 *
 * NOTE: we deliberately read the base from `config.default_base` rather
 * than `story.orchestrator.base_branch`. The two values are equal in
 * every case this helper would fire (prepareStoryBranch only deviates
 * from `default_base` when a dependency's tip is used, which by
 * definition means the dependency added commits — i.e. NOT a zero-diff
 * ship-gate story). Reading from config removes one piece of implicit
 * coupling between prepareStoryBranch and commitStoryArtefacts and
 * sidesteps any state-snapshot staleness in the helper's read path.
 * The `base_branch` field is still written by prepareStoryBranch for
 * forensic/audit purposes; it is just no longer load-bearing here.
 */
async function maybeLayDownShipGateEmptyCommit(
  ctx: ToolContext,
  story: Story,
): Promise<string | null> {
  const cfgRes = await getOrInitConfig(ctx);
  if (!cfgRes.config || cfgRes.config.pr_per_story !== true) return null;

  const baseBranch = cfgRes.config.default_base;
  if (typeof baseBranch !== "string" || baseBranch.length === 0) return null;

  // Ensure the recorded base actually exists locally. If not (e.g. the
  // story was authored outside the orchestrator), bail rather than
  // committing speculatively.
  const baseExists = await capture(ctx.projectRoot, "git", [
    "rev-parse",
    "--verify",
    "--quiet",
    baseBranch,
  ]);
  if (baseExists.exitCode !== 0) return null;

  const ahead = await capture(ctx.projectRoot, "git", [
    "rev-list",
    "--count",
    `${baseBranch}..HEAD`,
  ]);
  const aheadCount = Number.parseInt(ahead.stdout.trim(), 10);
  if (!Number.isFinite(aheadCount) || aheadCount !== 0) return null;

  const r = await run(ctx.projectRoot, "git", [
    "commit",
    "--allow-empty",
    "-m",
    shipGateEmptyCommitMessage(story.id),
    "--trailer",
    "Co-authored-by: Claude <noreply@anthropic.com>",
  ]);
  if (r.exitCode !== 0) return null;

  const sha = await capture(ctx.projectRoot, "git", ["rev-parse", "HEAD"]);
  return sha.stdout.trim() || null;
}

async function run(cwd: string, cmd: string, args: string[]): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "ignore" });
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
    child.on("error", () => resolve({ exitCode: 1 }));
  });
}

async function capture(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
    child.on("error", () => resolve({ exitCode: 1, stdout }));
  });
}
