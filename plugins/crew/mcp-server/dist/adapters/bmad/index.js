import { z } from "zod";
import { NotImplementedError } from "../../errors.js";
/**
 * BMad planning adapter — Story 1.1 scaffold, extended in Story 1.2
 * with `defaultConfig()` + `adapterConfigSchema` stubs.
 *
 * `listSourceStories` returns `[]` and the two new members are minimal
 * stubs. The remaining methods throw `NotImplementedError`; the real
 * implementation lands in Story 3.3.
 */
export const BmadAdapter = {
    name: "bmad",
    async detect(_targetRepo) {
        throw new NotImplementedError("bmad adapter: detect lands in Story 3.3");
    },
    async listSourceStories() {
        return [];
    },
    async readSourceStory(_ref) {
        throw new NotImplementedError("bmad adapter: readSourceStory lands in Story 3.3");
    },
    resolveSourcePath(_ref) {
        throw new NotImplementedError("bmad adapter: resolveSourcePath lands in Story 3.3");
    },
    defaultConfig() {
        return { stories_root: "_bmad-output/planning-artifacts/stories" };
    },
    adapterConfigSchema: z.object({ stories_root: z.string() }),
};
