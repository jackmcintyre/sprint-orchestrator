import { spawn } from "node:child_process";
import { readStdinJson } from "./lib/io.js";
import { defaultContext } from "@sprint-orchestrator/mcp-server/dist/tools/context.js";
import { readSprintStatus } from "@sprint-orchestrator/mcp-server/dist/state/sprint-status.js";
import { validateAcceptanceCriteria } from "@sprint-orchestrator/mcp-server/dist/tools/validate-acceptance-criteria.js";
import { markStoryComplete } from "@sprint-orchestrator/mcp-server/dist/tools/mark-story-complete.js";
import { markStoryFailed } from "@sprint-orchestrator/mcp-server/dist/tools/mark-story-failed.js";

/**
 * v1 (MAX=1 concurrency): if exactly one story is in_progress, treat it as
 * the active one for this session. If zero or >1, exit silently — we can't
 * disambiguate without a richer agent-identity model (Phase 6).
 */
export interface StopInput {
  cwd?: string;
}

export type StopOutcome =
  | { action: "noop"; reason: string }
  | { action: "completed"; storyId: string; sha: string | null }
  | { action: "failed"; storyId: string; reason: string };

export async function handleStop(input: StopInput | null): Promise<StopOutcome> {
  const projectRoot = input?.cwd ?? process.cwd();
  const ctx = defaultContext(projectRoot);

  let inProgress;
  try {
    const state = await readSprintStatus(ctx.sprintStatusPath);
    inProgress = state.stories.filter((s) => s.status === "in_progress");
  } catch {
    return { action: "noop", reason: "no sprint-status.yaml" };
  }
  if (inProgress.length === 0) return { action: "noop", reason: "nothing in progress" };
  if (inProgress.length > 1) return { action: "noop", reason: "multiple in_progress (ambiguous)" };

  const story = inProgress[0]!;
  const holder = story.orchestrator.claimed_by;
  if (!holder) return { action: "noop", reason: "in_progress story has no claimant" };

  const result = await validateAcceptanceCriteria(ctx, story.id);
  if (!result.passed) {
    const failed = result.results.filter((r) => !r.passed);
    const reason = `Acceptance criteria failed: ${failed.map((r) => r.type).join(", ")}`;
    await markStoryFailed(ctx, story.id, reason);
    return { action: "failed", storyId: story.id, reason };
  }

  const commitMessage = `feat(${story.id}): ${story.title}`;
  const sha = await commitAll(projectRoot, commitMessage);
  await markStoryComplete(ctx, story.id, holder, commitMessage, sha ? [`git:${sha}`] : []);
  return { action: "completed", storyId: story.id, sha };
}

export async function commitAll(projectRoot: string, message: string): Promise<string | null> {
  await run(projectRoot, "git", ["add", "-A"]);
  const status = await capture(projectRoot, "git", ["status", "--porcelain"]);
  if (!status.stdout.trim()) return null;
  const r = await run(projectRoot, "git", [
    "commit",
    "-m",
    message,
    "--trailer",
    "Co-authored-by: Claude <noreply@anthropic.com>",
  ]);
  if (r.exitCode !== 0) return null;
  const sha = await capture(projectRoot, "git", ["rev-parse", "HEAD"]);
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

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  readStdinJson<StopInput>()
    .then(handleStop)
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[stop]", err);
    });
}
