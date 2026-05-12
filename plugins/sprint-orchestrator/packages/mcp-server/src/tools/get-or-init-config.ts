import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { type ToolContext } from "./context.js";

export interface OrchestratorConfig {
  /** Where the sprint-status file lives, relative to projectRoot. */
  sprintStatusPath: string;
  /** Optional path to PRD doc. */
  prdPath?: string;
  /** Optional path to architecture doc. */
  architecturePath?: string;
  /** Optional path to stories directory. */
  storiesDir?: string;
  /** True if config was auto-detected from a known layout. */
  autoDetected: boolean;
  /** Layout name (e.g. "bmad-v6", "custom"). */
  layout: string;
  /**
   * If set, the process-backlog skill is permitted to auto-release stale
   * `in_progress` claims older than this many minutes at the start of a run.
   * Omit / leave undefined to require the user to call `releaseStaleClaims`
   * themselves (the safe default).
   */
  force_release_stale?: number;
}

export interface ConfigResult {
  config: OrchestratorConfig | null;
  needsSetup: boolean;
  /**
   * If needsSetup, suggested questions for Claude to ask the human.
   */
  setupQuestions?: string[];
}

/**
 * Returns the orchestrator config if one exists, or auto-detects BMAD v6
 * layout. If neither, returns needsSetup with prompts for the agent to ask
 * the user about their docs layout.
 */
export async function getOrInitConfig(ctx: ToolContext): Promise<ConfigResult> {
  const existing = await readExisting(ctx.configPath);
  if (existing) return { config: existing, needsSetup: false };

  const detected = await detectBmadV6(ctx.projectRoot);
  if (detected) {
    await writeConfig(ctx.configPath, detected);
    return { config: detected, needsSetup: false };
  }

  return {
    config: null,
    needsSetup: true,
    setupQuestions: [
      "Where does your sprint status file live? (relative path, e.g. sprint-status.yaml)",
      "Where is your PRD? (relative path, optional)",
      "Where is your architecture / solution-design doc? (relative path, optional)",
      "Where do individual story files live? (directory, optional)",
    ],
  };
}

/** Persist a user-provided or detected config. */
export async function writeConfig(configPath: string, config: OrchestratorConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, YAML.stringify(config, { lineWidth: 100 }), "utf8");
}

async function readExisting(configPath: string): Promise<OrchestratorConfig | null> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = YAML.parse(raw) as OrchestratorConfig | null;
    return parsed ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function detectBmadV6(projectRoot: string): Promise<OrchestratorConfig | null> {
  const candidates = {
    sprintStatusPath: "sprint-status.yaml",
    prdPath: "docs/prd.md",
    architecturePath: "docs/architecture.md",
    storiesDir: "docs/stories",
  };

  const sprintStatusExists = await pathExists(path.join(projectRoot, candidates.sprintStatusPath));
  if (!sprintStatusExists) return null;

  const config: OrchestratorConfig = {
    sprintStatusPath: candidates.sprintStatusPath,
    autoDetected: true,
    layout: "bmad-v6",
  };
  if (await pathExists(path.join(projectRoot, candidates.prdPath)))
    config.prdPath = candidates.prdPath;
  if (await pathExists(path.join(projectRoot, candidates.architecturePath)))
    config.architecturePath = candidates.architecturePath;
  if (await pathExists(path.join(projectRoot, candidates.storiesDir)))
    config.storiesDir = candidates.storiesDir;
  return config;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
