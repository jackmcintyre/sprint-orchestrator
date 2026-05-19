import { execa as defaultExeca } from "execa";
export interface GitCommitResult {
    commitSha: string;
    stdout: string;
    stderr: string;
}
/**
 * Single entrypoint for plugin-side git commits (Story 1.5 AC4).
 * Stages the given `paths` then commits with the given `message`.
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` forbids any
 * file other than this one from spawning `git` directly (AC6f).
 *
 * `role` is accepted for forward-compat (a later story will surface
 * it in the structured telemetry event for the commit). It is NOT
 * yet allowlist-checked — git is reached only from MCP tools that
 * themselves were already role-gated, so an extra git-side allowlist
 * would be redundant in v1.
 *
 * Refuses calls whose message does not match the required shape AND
 * calls with an empty `paths` set, in both cases BEFORE any
 * subprocess spawn (verified by an `execaImpl` spy in tests).
 *
 * Single-purpose: no retry, no `--no-verify`, no `-S` signing, no
 * `--amend`. Three `execa` calls, in order: `add`, `commit`, then
 * `rev-parse HEAD` to harvest the commit SHA.
 */
export declare function gitCommit(opts: {
    targetRepoRoot: string;
    paths: readonly string[];
    message: string;
    role: string;
    execaImpl?: typeof defaultExeca;
}): Promise<GitCommitResult>;
