import { rename, mkdir, stat } from "node:fs/promises";
import * as path from "node:path";
import {
  CrossFilesystemMoveError,
  InvalidStateNameError,
  ManifestNotFoundError,
} from "../errors.js";

/**
 * The canonical state-machine directory names. A manifest at
 * `<targetRepoRoot>/.claude-dev-loop/state/<state>/<ref>.yaml` is
 * "in" the named state by virtue of its parent directory. (NFR8)
 */
export const STATE_NAMES = [
  "to-do",
  "in-progress",
  "blocked",
  "done",
] as const;

export type StateName = (typeof STATE_NAMES)[number];

export interface MoveResult {
  from: StateName;
  to: StateName;
  ref: string;
  absFromPath: string;
  absToPath: string;
}

/**
 * Narrow filesystem-injection seam used for testing the EXDEV /
 * spy-on-call-count paths. Production callers must NOT pass `fsImpl` —
 * the default binds to `node:fs/promises`. The interface deliberately
 * exposes ONLY `rename`, `mkdir`, `stat` so a maintainer cannot
 * accidentally introduce a copy+delete fallback (which would violate
 * NFR8's single-syscall atomicity).
 */
export interface FsImpl {
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  stat(p: string): Promise<unknown>;
}

const DEFAULT_FS_IMPL: FsImpl = {
  rename: (from, to) => rename(from, to),
  mkdir: (dir, opts) => mkdir(dir, opts),
  stat: (p) => stat(p),
};

function isStateName(value: string): value is StateName {
  return (STATE_NAMES as readonly string[]).includes(value);
}

/**
 * Move a manifest between two canonical state directories via a
 * single `fs.rename(2)` syscall. This is the ONLY file in
 * `mcp-server/src/**` permitted to invoke `rename` against a
 * state-machine path (enforced by a static guard in
 * `tests/canonical-fs-guard.test.ts`).
 *
 * The function is a pure structural primitive — it does NOT read or
 * write manifest contents, does NOT emit telemetry, does NOT acquire
 * locks. POSIX `rename(2)` (and the macOS/Linux equivalents) is itself
 * the atomicity guarantee within a single filesystem. Cross-filesystem
 * moves are explicitly out of v1 scope: an `EXDEV` errno surfaces as
 * a typed `CrossFilesystemMoveError` with no copy+delete fallback.
 *
 * See Story 1.6, `core-architectural-decisions.md` lines 27–40,
 * NFR8 / NFR9 / NFR19.
 */
export async function moveBetweenStates(opts: {
  targetRepoRoot: string;
  ref: string;
  from: StateName;
  to: StateName;
  fsImpl?: FsImpl;
}): Promise<MoveResult> {
  const { targetRepoRoot, ref, from, to } = opts;
  const fsImpl = opts.fsImpl ?? DEFAULT_FS_IMPL;

  // 1. Validate state names. No filesystem touch.
  if (!isStateName(from) || !isStateName(to)) {
    throw new InvalidStateNameError({
      attemptedFrom: from,
      attemptedTo: to,
      allowedStates: STATE_NAMES,
      reason: "unknown state name",
    });
  }

  // 2. Compute paths.
  const stateRoot = path.join(targetRepoRoot, ".claude-dev-loop", "state");
  const absFromPath = path.join(stateRoot, from, ref + ".yaml");
  const absToPath = path.join(stateRoot, to, ref + ".yaml");

  // 3. Path-escape guard (mirrors managed-fs.ts line 85). The `ref`
  //    parameter is not regex-validated; this is the last line of
  //    defense against `ref` values like `../../etc/passwd`.
  for (const absPath of [absFromPath, absToPath]) {
    const rel = path.relative(stateRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new InvalidStateNameError({
        attemptedFrom: from,
        attemptedTo: to,
        allowedStates: STATE_NAMES,
        reason: "path escapes state root",
      });
    }
  }

  // 4. Ensure destination directory exists. `fs.rename` does NOT
  //    create parent directories itself.
  await fsImpl.mkdir(path.dirname(absToPath), { recursive: true });

  // 5. Single rename syscall. NO copy+delete fallback on EXDEV.
  try {
    await fsImpl.rename(absFromPath, absToPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EXDEV") {
      throw new CrossFilesystemMoveError({
        absFromPath,
        absToPath,
        ref,
        originalCode: "EXDEV",
      });
    }
    if (code === "ENOENT") {
      throw new ManifestNotFoundError({
        ref,
        expectedAbsPath: absFromPath,
        fromState: from,
      });
    }
    throw err;
  }

  return { from, to, ref, absFromPath, absToPath };
}
