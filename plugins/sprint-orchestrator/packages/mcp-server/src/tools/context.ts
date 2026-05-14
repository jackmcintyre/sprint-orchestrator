import * as path from "node:path";

/** Legacy on-disk location, used only for one-time migration on first read. */
export const LEGACY_SPRINT_STATUS_FILENAME = "sprint-status.yaml";
/** Canonical state file, lives outside git under `.sprint-orchestrator/`. */
export const STATE_FILE_RELATIVE = path.join(".sprint-orchestrator", "state.yaml");

export interface ToolContext {
  /** Project root the plugin operates in (cwd by default). */
  projectRoot: string;
  /**
   * Absolute path to the orchestrator state file
   * (`<projectRoot>/.sprint-orchestrator/state.yaml`).
   *
   * Historically named `sprintStatusPath` and pointed at
   * `<projectRoot>/sprint-status.yaml`. As of story 1 of the
   * orchestrator-state-and-shipgate sprint the canonical file moved out
   * of git into `.sprint-orchestrator/state.yaml`. Old name kept to avoid
   * a sprawling rename — see `LEGACY_SPRINT_STATUS_FILENAME` for the
   * pre-migration location.
   */
  sprintStatusPath: string;
  /** Absolute path to .sprint-orchestrator/config.yaml. */
  configPath: string;
  /**
   * Override for the directory the resolver reads agent files (dev.md,
   * reviewer.md) from. Only set by the e2e harness; in normal runs the
   * resolver derives the plugin-local agents/ directory from
   * `import.meta.url`. See `resolve-spawn-model.ts`.
   */
  agentsDir?: string;
}

export function defaultContext(projectRoot: string = process.cwd()): ToolContext {
  return {
    projectRoot,
    sprintStatusPath: path.join(projectRoot, STATE_FILE_RELATIVE),
    configPath: path.join(projectRoot, ".sprint-orchestrator", "config.yaml"),
  };
}
