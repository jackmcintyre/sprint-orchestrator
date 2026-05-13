import { readSprintStatus, writeSprintStatus } from "../state/sprint-status.js";
import { type SprintStatus, type Story } from "../state/schema.js";
import { type ToolContext } from "./context.js";
import { withLock } from "../lib/lock.js";

/**
 * Returns stories with `status: ready` whose dependencies are all `done`.
 * Excludes stories whose declared deps don't exist (treated as unmet).
 *
 * Self-healing: any story authored as `status: backlog` whose dependencies
 * are all `done` (including stories with no deps) is promoted to `ready`
 * and persisted before the result is computed. This means a sprint plan
 * can be authored entirely in `backlog` and the orchestrator will pick
 * stories up as their deps complete, without requiring an explicit
 * promotion step.
 */
export async function getReadyStories(ctx: ToolContext): Promise<Story[]> {
  await promoteBacklogStories(ctx.sprintStatusPath);
  const state = await readSprintStatus(ctx.sprintStatusPath);
  const doneIds = new Set(state.stories.filter((s) => s.status === "done").map((s) => s.id));
  const storyIds = new Set(state.stories.map((s) => s.id));
  return state.stories.filter(
    (s) => s.status === "ready" && s.depends_on.every((d) => storyIds.has(d) && doneIds.has(d)),
  );
}

/**
 * Promote any backlog stories whose deps are all `done` to `ready`.
 * Acquires the file lock and only writes when something actually changed.
 * A backlog story whose declared dep does not exist is left alone (treated
 * as unmet) so authoring typos don't auto-promote.
 */
async function promoteBacklogStories(path: string): Promise<void> {
  await withLock(path, async () => {
    const current = await readSprintStatus(path);
    const doneIds = new Set(current.stories.filter((s) => s.status === "done").map((s) => s.id));
    const storyIds = new Set(current.stories.map((s) => s.id));

    let changed = false;
    const nextStories = current.stories.map((s) => {
      if (s.status === "backlog" && s.depends_on.every((d) => storyIds.has(d) && doneIds.has(d))) {
        changed = true;
        return { ...s, status: "ready" as const };
      }
      return s;
    });

    if (!changed) return;
    const next: SprintStatus = { ...current, stories: nextStories };
    await writeSprintStatus(path, next);
  });
}
