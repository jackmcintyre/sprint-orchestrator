import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CanonicalFsWriteError } from "../errors.js";

/**
 * Canonical-state path globs, relative to `<targetRepoRoot>`. These are
 * the paths only MCP tools are permitted to mutate (FR81 / NFR16).
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` (AC5c) walks
 * `mcp-server/src/**` and forbids any file other than this module (and,
 * once it lands in Story 1.5, `lib/logger.ts`) from importing a
 * write-shaped `node:fs` API.
 */
export const CANONICAL_PATH_GLOBS: readonly string[] = [
  ".crew/state/**",
  ".crew/telemetry/**",
  ".crew/retro-proposals/**",
  ".crew/sprint-history/**",
  ".crew/sessions/**",
  "team/**",
  "docs/standards.md",
  "docs/risk-tiering.md",
  "docs/discipline-rules.yaml",
];

/**
 * Match a single path segment against a glob segment. Supports exact
 * matches; the caller handles `**` as a wildcard that consumes one or
 * more segments.
 */
function segmentMatches(globSeg: string, pathSeg: string): boolean {
  return globSeg === pathSeg;
}

/**
 * Tiny dependency-free glob matcher. Supports `**` (matches zero or
 * more path segments) and exact-segment matches. Sufficient for the
 * canonical-path globs above; not a general-purpose glob engine.
 */
function matchGlob(glob: string, relPath: string): boolean {
  const globSegments = glob.split("/").filter((s) => s.length > 0);
  const pathSegments = relPath.split("/").filter((s) => s.length > 0);

  function recurse(gi: number, pi: number): boolean {
    if (gi === globSegments.length) {
      return pi === pathSegments.length;
    }
    const g = globSegments[gi]!;
    if (g === "**") {
      // `**` matches zero or more segments.
      for (let consume = 0; consume <= pathSegments.length - pi; consume++) {
        if (recurse(gi + 1, pi + consume)) return true;
      }
      return false;
    }
    if (pi >= pathSegments.length) return false;
    if (!segmentMatches(g, pathSegments[pi]!)) return false;
    return recurse(gi + 1, pi + 1);
  }

  return recurse(0, 0);
}

/**
 * Match an absolute path against the canonical-path globs, relative
 * to `targetRepoRoot`. Pure. Returns the first matched glob or
 * `{ canonical: false }`.
 *
 * Rejects path-traversal escapes — if the resolved relative path
 * begins with `..` (the absolute path is outside the repo root), the
 * function returns `{ canonical: false }` rather than matching, since
 * such a write is by definition not a canonical-state write under
 * this repo.
 */
export function isCanonicalPath(
  absPath: string,
  targetRepoRoot: string,
): { canonical: boolean; matchedGlob?: string } {
  const normalisedAbs = path.resolve(absPath);
  const normalisedRoot = path.resolve(targetRepoRoot);
  const rel = path.relative(normalisedRoot, normalisedAbs);

  // Path-traversal guard: anything outside the repo root is not a
  // canonical-state write for this repo.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { canonical: false };
  }

  // Normalise to forward slashes for glob matching.
  const relPosix = rel.split(path.sep).join("/");

  for (const glob of CANONICAL_PATH_GLOBS) {
    if (matchGlob(glob, relPosix)) {
      return { canonical: true, matchedGlob: glob };
    }
  }

  return { canonical: false };
}

/**
 * The ONLY entrypoint in the MCP server permitted to write a file
 * under a canonical-state path (FR81 / NFR16). When the target path
 * is non-canonical, the write passes through; when it is canonical,
 * the call requires an explicit `mcpToolContext` (proof that an MCP
 * tool — not arbitrary code — is the caller) and otherwise throws
 * `CanonicalFsWriteError`.
 *
 * Creates parent directories with `{ recursive: true }` before
 * writing. UTF-8 encoding.
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` enforces
 * that no other file in `mcp-server/src/**` imports a write-shaped
 * `node:fs` API.
 */
export async function writeManagedFile(opts: {
  absPath: string;
  contents: string;
  targetRepoRoot: string;
  mcpToolContext?: { toolName: string; role: string };
}): Promise<void> {
  const { absPath, contents, targetRepoRoot, mcpToolContext } = opts;
  const match = isCanonicalPath(absPath, targetRepoRoot);

  if (match.canonical && !mcpToolContext) {
    throw new CanonicalFsWriteError({
      attemptedPath: absPath,
      canonicalPathGlob: match.matchedGlob ?? "<unknown>",
    });
  }

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, contents, "utf8");
}
