import { promises as fs } from "node:fs";
import * as YAML from "yaml";

import { type ToolContext } from "./context.js";
import { writeConfig, type OrchestratorConfig } from "./get-or-init-config.js";
import { appendRunLog } from "../lib/run-log.js";

export interface SetConfigPrPerStoryResult {
  ok: boolean;
  pr_per_story: boolean;
  /** Present when the tool refused because no config exists yet. */
  error?: string;
}

/**
 * Persist the user's `pr_per_story` preference to `.sprint-orchestrator/config.yaml`.
 *
 * Refuses cleanly if no config file exists yet — the user must answer the
 * layout setup questions (via `getOrInitConfig`) before this tool can run.
 *
 * Story 5 of the mvp-polish sprint introduces this tool so the
 * process-backlog skill can persist the user's answer to the
 * PR_PER_STORY_SETUP_PROMPT without requiring a full re-init.
 */
export async function setConfigPrPerStory(
  ctx: ToolContext,
  value: boolean,
): Promise<SetConfigPrPerStoryResult> {
  const existing = await readExistingConfig(ctx.configPath);
  if (!existing) {
    return {
      ok: false,
      pr_per_story: value,
      error:
        "No config file found at the expected path. Run `getOrInitConfig` and complete the layout setup first.",
    };
  }

  const updated = { ...existing, pr_per_story: value };
  await writeConfig(ctx.configPath, updated);
  await appendRunLog(ctx.projectRoot, {
    event: "config_mutation",
    at: new Date().toISOString(),
    tool: "setConfigPrPerStory",
    pr_per_story: value,
  });
  return { ok: true, pr_per_story: value };
}

async function readExistingConfig(configPath: string): Promise<OrchestratorConfig | null> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = YAML.parse(raw) as OrchestratorConfig | null;
    return parsed ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
