import type { z } from "zod";

/**
 * Planning-adapter contract.
 *
 * Story 1.1 ships the interface only (with an empty `BmadAdapter`).
 * Story 1.2 extends it with `defaultConfig()` and `adapterConfigSchema`
 * — used by the workspace resolver to synthesise a fresh config and to
 * validate the per-adapter `adapter_config` block from config.yaml.
 * Story 3.1 wires up the registry and `getActiveAdapter()`.
 * Story 3.3 lands the real `BmadAdapter` methods.
 */
export interface PlanningAdapter {
  name: string;
  detect(targetRepo: string): Promise<boolean>;
  listSourceStories(): Promise<SourceStory[]>;
  readSourceStory(ref: string): Promise<SourceStory>;
  resolveSourcePath(ref: string): string;
  watchForChanges?(): AsyncIterable<ChangeEvent>;
  /**
   * Default `adapter_config` block written into `.crew/config.yaml`
   * on first-run auto-detect (Story 1.2 AC2).
   */
  defaultConfig(): Record<string, unknown>;
  /**
   * Zod schema that validates the adapter's `adapter_config` block from
   * a loaded `.crew/config.yaml` (Story 1.2 AC1, AC3).
   */
  adapterConfigSchema: z.ZodTypeAny;
}

export type AC = { text: string; kind: "integration" | "unit" };

export type SourceStory = {
  ref: string;
  title: string;
  narrative: string;
  acceptance_criteria: AC[];
  depends_on: string[];
  implementation_notes?: string;
  raw_path: string;
  raw_frontmatter: Record<string, unknown>;
  source_hash: string;
};

export type ChangeEvent =
  | { kind: "added"; ref: string }
  | { kind: "edited"; ref: string; new_hash: string }
  | { kind: "removed"; ref: string };
