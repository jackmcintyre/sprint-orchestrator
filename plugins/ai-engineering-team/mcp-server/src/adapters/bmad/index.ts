import { z } from "zod";
import { NotImplementedError } from "../../errors.js";
import type { PlanningAdapter, SourceStory } from "../adapter.js";

/**
 * BMad planning adapter — Story 1.1 scaffold, extended in Story 1.2
 * with `defaultConfig()` + `adapterConfigSchema` stubs.
 *
 * `listSourceStories` returns `[]` and the two new members are minimal
 * stubs. The remaining methods throw `NotImplementedError`; the real
 * implementation lands in Story 3.3.
 */
export const BmadAdapter: PlanningAdapter = {
  name: "bmad",

  async detect(_targetRepo: string): Promise<boolean> {
    throw new NotImplementedError("bmad adapter: detect lands in Story 3.3");
  },

  async listSourceStories(): Promise<SourceStory[]> {
    return [];
  },

  async readSourceStory(_ref: string): Promise<SourceStory> {
    throw new NotImplementedError("bmad adapter: readSourceStory lands in Story 3.3");
  },

  resolveSourcePath(_ref: string): string {
    throw new NotImplementedError("bmad adapter: resolveSourcePath lands in Story 3.3");
  },

  defaultConfig(): Record<string, unknown> {
    return { stories_root: "_bmad-output/planning-artifacts/stories" };
  },

  adapterConfigSchema: z.object({ stories_root: z.string() }),
};
