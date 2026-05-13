import { spawn } from "node:child_process";
import { findStory, readSprintStatus } from "../state/sprint-status.js";
import { type ToolContext } from "./context.js";

export interface CommitResult {
  sha: string | null;
}

/**
 * Pathspec exclusions applied to every `git add` / `git status` invocation
 * inside `commitStoryArtefacts`. Built-in defaults so the tool stays clean
 * even in repos whose `.gitignore` is missing or incomplete:
 *
 * - `sprint-status.yaml` — orchestrator state, committed separately by
 *   markStoryComplete so reverting a code commit does not roll back the
 *   state machine.
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
  ":!.sprint-orchestrator",
  ":!.sprint-orchestrator/**",
  ":!.claude",
  ":!.claude/**",
  ":!**/.DS_Store",
  ":!node_modules",
  ":!node_modules/**",
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
  if (!status.stdout.trim()) return { sha: null };

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
