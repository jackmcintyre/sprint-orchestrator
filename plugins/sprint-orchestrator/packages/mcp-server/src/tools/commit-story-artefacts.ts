import { spawn } from "node:child_process";
import { findStory, readSprintStatus } from "../state/sprint-status.js";
import { type ToolContext } from "./context.js";

export interface CommitResult {
  sha: string | null;
}

/**
 * Stage and commit the working tree as the result of completing one story.
 *
 * - Runs `git add -A` and `git commit -m "feat(<storyId>): <title>"` with a
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

  await run(ctx.projectRoot, "git", ["add", "-A"]);
  const status = await capture(ctx.projectRoot, "git", ["status", "--porcelain"]);
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
