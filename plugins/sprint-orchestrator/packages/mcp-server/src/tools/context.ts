import * as path from "node:path";

export interface ToolContext {
  /** Project root the plugin operates in (cwd by default). */
  projectRoot: string;
  /** Absolute path to sprint-status.yaml. */
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
    sprintStatusPath: path.join(projectRoot, "sprint-status.yaml"),
    configPath: path.join(projectRoot, ".sprint-orchestrator", "config.yaml"),
  };
}
