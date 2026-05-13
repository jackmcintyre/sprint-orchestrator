import { spawn } from "node:child_process";

export interface CommitStateResult {
  /** SHA of the commit, or `null` if there was nothing to commit. */
  sha: string | null;
}

/**
 * Stage and commit ONLY `sprint-status.yaml` with the supplied message.
 *
 * Idempotent: if the file is clean (no diff vs HEAD, nothing staged), this
 * resolves with `{ sha: null }` instead of creating an empty commit. State
 * mutators (markStoryComplete / markStoryFailed / markStoryNeedsRework) call
 * this AFTER persisting their YAML mutation so orchestrator state lands as a
 * commit distinct from the dev's code commit. That separation lets a code
 * commit be reverted without rolling back the state machine, and vice versa.
 */
export async function commitSprintState(cwd: string, message: string): Promise<CommitStateResult> {
  // Stage only sprint-status.yaml (if it exists / is dirty); never -A.
  await run(cwd, "git", ["add", "--", "sprint-status.yaml"]);

  // After staging, check whether anything is actually queued for commit.
  // `--porcelain` prints nothing when the path is clean.
  const status = await capture(cwd, "git", ["status", "--porcelain", "--", "sprint-status.yaml"]);
  if (!status.stdout.trim()) return { sha: null };

  const r = await run(cwd, "git", [
    "commit",
    "-m",
    message,
    "--trailer",
    "Co-authored-by: Claude <noreply@anthropic.com>",
    "--only",
    "--",
    "sprint-status.yaml",
  ]);
  if (r.exitCode !== 0) return { sha: null };

  const sha = await capture(cwd, "git", ["rev-parse", "HEAD"]);
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
