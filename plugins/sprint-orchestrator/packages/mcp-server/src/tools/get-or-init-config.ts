import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { type ToolContext } from "./context.js";
import { PR_PER_STORY_SETUP_PROMPT } from "./pr-per-story-setup-phrases.js";

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
  /**
   * If true, the orchestrator creates a per-story branch before the dev
   * subagent commits. Defaults to `false` while the per-story workflow is
   * incomplete — push, PR creation, and dependency-aware branch rooting
   * land in later slices. Opt in explicitly to test the in-flight slices.
   */
  pr_per_story?: boolean;
  /**
   * Default base branch that per-story PRs are opened against. Defaults to
   * `"main"` when omitted.
   *
   * NOTE: This field is currently passive — it is parsed and round-tripped
   * through the config but no consumer reads it yet. Story 2 wires it in.
   */
  default_base?: string;
  /**
   * Per-story budget the `run-sprint` wrapper skill uses when computing the
   * `/goal` turn cap (turn_cap = ceil(N_stories * turn_cap_per_story)).
   * Defaults to 3, which matches the per-story worst-case under the current
   * rework cap of 2 (dev + reviewer + one rework dev + reviewer rounded up).
   *
   * Read by the wrapper skill only — the orchestrator core does not consume
   * this field. Kept here so it round-trips through writeConfig and surfaces
   * alongside other tuning knobs.
   */
  turn_cap_per_story?: number;
  /**
   * Optional per-role model overrides applied at spawn time. When a
   * role's entry is set, `resolveSpawnModel` returns that model ID for
   * the role instead of reading the agent file's `model:` frontmatter
   * or falling back to `DEFAULT_*_MODEL`. Story 1 of model-tiering-v1
   * introduces this block; later stories may extend it.
   */
  models?: {
    /** Override for the dev subagent. Omit to keep the frontmatter default. */
    dev?: string;
    /** Override for the reviewer subagent. Omit to keep the frontmatter default. */
    reviewer?: string;
  };
}

/** Defaults applied when a config omits the new pr-per-story fields. */
const DEFAULT_PR_PER_STORY = false;
const DEFAULT_BASE_BRANCH = "main";
/** Default per-story turn budget used by the run-sprint wrapper skill. */
export const DEFAULT_TURN_CAP_PER_STORY = 3;

function withPrPerStoryDefaults(config: OrchestratorConfig): OrchestratorConfig {
  return {
    ...config,
    pr_per_story: config.pr_per_story ?? DEFAULT_PR_PER_STORY,
    default_base: config.default_base ?? DEFAULT_BASE_BRANCH,
  };
}

export interface ConfigResult {
  config: OrchestratorConfig | null;
  needsSetup: boolean;
  /**
   * Suggested questions for Claude to ask the human. Present when `needsSetup`
   * is true (layout questions) AND/OR when the config exists but `pr_per_story`
   * was not explicitly set (the PR_PER_STORY_SETUP_PROMPT is appended). The
   * orchestrator skill should surface all entries regardless of `needsSetup`.
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
  if (existing) {
    const needsPrPrompt = existing.pr_per_story === undefined;
    return {
      config: withPrPerStoryDefaults(existing),
      needsSetup: false,
      ...(needsPrPrompt ? { setupQuestions: [PR_PER_STORY_SETUP_PROMPT] } : {}),
    };
  }

  const detected = await detectBmadV6(ctx.projectRoot);
  if (detected) {
    await writeConfig(ctx.configPath, detected);
    return {
      config: withPrPerStoryDefaults(detected),
      needsSetup: false,
      setupQuestions: [PR_PER_STORY_SETUP_PROMPT],
    };
  }

  return {
    config: null,
    needsSetup: true,
    setupQuestions: [
      "Where does your sprint status file live? (relative path, e.g. sprint-status.yaml)",
      "Where is your PRD? (relative path, optional)",
      "Where is your architecture / solution-design doc? (relative path, optional)",
      "Where do individual story files live? (directory, optional)",
      PR_PER_STORY_SETUP_PROMPT,
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

  // Accept either the legacy in-git `sprint-status.yaml` (pre-migration
  // checkouts) or the new out-of-git `.sprint-orchestrator/state.yaml`
  // (post-migration / fresh adopt). Either signals an orchestrator-managed
  // project.
  const legacyExists = await pathExists(path.join(projectRoot, candidates.sprintStatusPath));
  const stateExists = await pathExists(
    path.join(projectRoot, ".sprint-orchestrator", "state.yaml"),
  );
  if (!legacyExists && !stateExists) return null;

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
