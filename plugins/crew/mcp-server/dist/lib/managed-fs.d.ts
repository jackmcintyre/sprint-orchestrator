/**
 * Canonical-state path globs, relative to `<targetRepoRoot>`. These are
 * the paths only MCP tools are permitted to mutate (FR81 / NFR16).
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` (AC5c) walks
 * `mcp-server/src/**` and forbids any file other than this module (and,
 * once it lands in Story 1.5, `lib/logger.ts`) from importing a
 * write-shaped `node:fs` API.
 */
export declare const CANONICAL_PATH_GLOBS: readonly string[];
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
export declare function isCanonicalPath(absPath: string, targetRepoRoot: string): {
    canonical: boolean;
    matchedGlob?: string;
};
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
export declare function writeManagedFile(opts: {
    absPath: string;
    contents: string;
    targetRepoRoot: string;
    mcpToolContext?: {
        toolName: string;
        role: string;
    };
}): Promise<void>;
