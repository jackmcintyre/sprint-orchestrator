import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

import { DEFAULT_TURN_CAP_PER_STORY, type OrchestratorConfig } from "./get-or-init-config.js";
import { UNCOMMITTED_BACKLOG_REFUSAL } from "./run-sprint-preflight-phrases.js";
import { readSprintStatus } from "../state/sprint-status.js";
import { StateNotFoundError } from "../lib/errors.js";

/**
 * Pure planner for the `run-sprint` wrapper skill.
 *
 * The wrapper is a thin entrypoint that:
 *   - reads sprint-status.yaml from cwd
 *   - counts stories N
 *   - reads turn_cap_per_story from .sprint-orchestrator/config.yaml (default 3)
 *   - computes turn_cap = ceil(N * turn_cap_per_story)
 *   - invokes /goal with the canonical drain condition
 *
 * This module is the planner step. The skill's prompt instructs Claude
 * to call it (or replicate its logic) and emit the resulting command.
 * The e2e harness imports it directly so the asserted output is the
 * same string a human would see.
 */

export interface PlanRunSprintInput {
  /** Working directory the user invoked /run-sprint from. */
  cwd: string;
}

export type PlanRunSprintResult =
  | {
      kind: "ok";
      storyCount: number;
      turnCapPerStory: number;
      turnCap: number;
      /** Exact /goal command the wrapper would emit. */
      command: string;
    }
  | {
      kind: "refuse";
      /** Why the wrapper refuses. Surfaced verbatim to the user. */
      reason: "missing_backlog" | "drained" | "uncommitted_backlog";
      message: string;
    };

/**
 * Preflight: is the cwd inside a git repo, and if so, does
 * `sprint-status.yaml` have uncommitted changes (untracked, modified, or
 * staged)? Returns the verbatim refusal message when the backlog is
 * dirty; returns `null` when it's clean, untracked-outside-a-git-repo,
 * or git is unavailable (the preflight is best-effort — we don't want to
 * brick the wrapper on systems without git).
 *
 * Implementation: `git status --porcelain -- <sprintStatusPath>` printing
 * any line means the file is dirty in some way the user must commit
 * before launching. Anything else (no git, no repo, clean tree) is a pass.
 */
export function checkUncommittedBacklog(cwd: string): string | null {
  const sprintStatusPath = path.join(cwd, "sprint-status.yaml");

  // Fast path: only run git if the file actually exists. The
  // missing-backlog refusal handles the not-there case separately.
  if (!existsSync(sprintStatusPath)) return null;

  // First confirm we're inside a git repo — outside one, "uncommitted"
  // is meaningless and we should let the rest of the planner proceed.
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
  });
  if (inside.status !== 0) return null;
  if ((inside.stdout ?? "").trim() !== "true") return null;

  const r = spawnSync("git", ["status", "--porcelain", "--", "sprint-status.yaml"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return null; // git error → best-effort pass

  const output = (r.stdout ?? "").trim();
  if (output.length === 0) return null;

  return UNCOMMITTED_BACKLOG_REFUSAL;
}

/**
 * Canonical drain condition, used verbatim in the emitted /goal command.
 * Kept as a single template so the wrapper, docs, and tests cannot drift.
 */
export function buildDrainCondition(turnCap: number): string {
  return `every story in sprint-status.yaml is status=done or status=failed, OR stop after ${turnCap} turns`;
}

export function buildGoalCommand(turnCap: number): string {
  return `/goal /sprint-orchestrator:process-backlog UNTIL ${buildDrainCondition(turnCap)}`;
}

async function readTurnCapPerStory(cwd: string): Promise<number> {
  const configPath = path.join(cwd, ".sprint-orchestrator", "config.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = YAML.parse(raw) as Partial<OrchestratorConfig> | null;
    const v = parsed?.turn_cap_per_story;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    return DEFAULT_TURN_CAP_PER_STORY;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TURN_CAP_PER_STORY;
    throw err;
  }
}

export async function planRunSprint(input: PlanRunSprintInput): Promise<PlanRunSprintResult> {
  const sprintStatusPath = path.join(input.cwd, "sprint-status.yaml");

  let sprint;
  try {
    sprint = await readSprintStatus(sprintStatusPath);
  } catch (err) {
    if (err instanceof StateNotFoundError) {
      return {
        kind: "refuse",
        reason: "missing_backlog",
        message:
          `no backlog found: expected sprint-status.yaml at ${sprintStatusPath}. ` +
          `Copy a backlog file there before running.`,
      };
    }
    throw err;
  }

  // Preflight: refuse to launch if sprint-status.yaml is dirty in git.
  // A story PR merging to main mid-run would otherwise overwrite the
  // live backlog and force manual recovery from a dangling git blob.
  const uncommittedRefusal = checkUncommittedBacklog(input.cwd);
  if (uncommittedRefusal !== null) {
    return {
      kind: "refuse",
      reason: "uncommitted_backlog",
      message: uncommittedRefusal,
    };
  }

  const stories = sprint.stories;
  const total = stories.length;
  const done = stories.filter((s) => s.status === "done").length;
  const failed = stories.filter((s) => s.status === "failed").length;

  if (total > 0 && done + failed === total) {
    return {
      kind: "refuse",
      reason: "drained",
      message: `nothing to run — backlog is drained. Stories: ${done} done, ${failed} failed.`,
    };
  }

  const turnCapPerStory = await readTurnCapPerStory(input.cwd);
  const turnCap = Math.ceil(total * turnCapPerStory);

  return {
    kind: "ok",
    storyCount: total,
    turnCapPerStory,
    turnCap,
    command: buildGoalCommand(turnCap),
  };
}
