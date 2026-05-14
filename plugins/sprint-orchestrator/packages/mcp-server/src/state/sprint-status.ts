import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { SprintStatus, type Story } from "./schema.js";
import { StateNotFoundError, StateParseError, StoryNotFoundError } from "../lib/errors.js";
import { withLock } from "../lib/lock.js";

/**
 * Filename of the legacy in-git state file. When the new `.sprint-orchestrator/state.yaml`
 * is absent but a sibling project root has the old file, `migrateLegacyState`
 * moves it across so an existing checkout keeps running without a manual step.
 */
const LEGACY_FILENAME = "sprint-status.yaml";

/**
 * One-time migration from the in-git `sprint-status.yaml` to the out-of-git
 * `.sprint-orchestrator/state.yaml`. Idempotent: when the target already
 * exists, we do nothing — even if the legacy file is also present, the
 * canonical out-of-git copy wins.
 *
 * Heuristic: when the requested state path lives under
 * `.sprint-orchestrator/`, treat its grandparent as the project root and
 * look for `sprint-status.yaml` there. This keeps the helper API
 * path-shaped (matching `readSprintStatus`) without forcing a `ToolContext`
 * through every caller.
 */
export async function migrateLegacyState(statePath: string): Promise<void> {
  // Target already in place — no migration needed.
  try {
    await fs.access(statePath);
    return;
  } catch {
    // fall through to migration
  }

  // Only auto-migrate when the target is in the expected
  // `<root>/.sprint-orchestrator/state.yaml` shape; for ad-hoc paths the
  // caller is on their own.
  const dir = path.dirname(statePath);
  if (path.basename(dir) !== ".sprint-orchestrator") return;
  const projectRoot = path.dirname(dir);
  const legacyPath = path.join(projectRoot, LEGACY_FILENAME);

  let legacyContent: string;
  try {
    legacyContent = await fs.readFile(legacyPath, "utf8");
  } catch {
    return; // no legacy file either — nothing to migrate
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(statePath, legacyContent, "utf8");
  // Deliberately leave the legacy `sprint-status.yaml` untouched in the
  // working tree. In real projects it is typically committed; mutating it
  // here would dirty the index and surface as spurious diffs on every
  // checkout. Users who want a cleaner repo can `git rm sprint-status.yaml`
  // themselves once the new state file is in place.
}

/**
 * Read the orchestrator state file (canonically
 * `.sprint-orchestrator/state.yaml`) and validate against the zod schema.
 *
 * If the target file is missing but a legacy `sprint-status.yaml` exists at
 * the project root, this transparently migrates the legacy file across
 * before reading. Unknown fields are preserved. Throws on missing file or
 * invalid YAML/shape.
 *
 * @throws StateNotFoundError, StateParseError
 */
export async function readSprintStatus(filePath: string): Promise<SprintStatus> {
  await migrateLegacyState(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StateNotFoundError(filePath);
    throw new StateParseError(filePath, err);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new StateParseError(filePath, err);
  }
  const result = SprintStatus.safeParse(parsed);
  if (!result.success) throw new StateParseError(filePath, result.error);
  return result.data;
}

/**
 * Atomically write the sprint state back to disk, preserving comment-less
 * structure. Caller is responsible for holding the lock.
 */
export async function writeSprintStatus(filePath: string, value: SprintStatus): Promise<void> {
  const yaml = YAML.stringify(value, { lineWidth: 100 });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, yaml, "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Read-modify-write helper. Acquires the file lock, reads, runs `mutator`
 * (which may return a Story update or new SprintStatus), writes if changed.
 *
 * @throws LockTimeoutError, StateNotFoundError, StateParseError
 */
export async function updateSprintStatus<T>(
  filePath: string,
  mutator: (current: SprintStatus) => Promise<{ next: SprintStatus; result: T }>,
): Promise<T> {
  await migrateLegacyState(filePath);
  // Ensure the directory exists before proper-lockfile tries to create a
  // sibling lockfile — required on fresh checkouts where
  // `.sprint-orchestrator/` does not exist yet.
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return withLock(filePath, async () => {
    const current = await readSprintStatus(filePath);
    const { next, result } = await mutator(current);
    await writeSprintStatus(filePath, next);
    return result;
  });
}

export function findStory(state: SprintStatus, storyId: string): Story {
  const story = state.stories.find((s) => s.id === storyId);
  if (!story) throw new StoryNotFoundError(storyId);
  return story;
}

export function replaceStory(state: SprintStatus, updated: Story): SprintStatus {
  return {
    ...state,
    stories: state.stories.map((s) => (s.id === updated.id ? updated : s)),
  };
}
