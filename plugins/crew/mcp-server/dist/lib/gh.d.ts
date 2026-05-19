import { execa as defaultExeca } from "execa";
import type { RolePermissions } from "../schemas/role-permissions.js";
export interface GhCallResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * Single entrypoint for `gh` invocations from the MCP server (NFR17 /
 * NFR12 / NFR16). Enforces the calling role's `gh_allow` before
 * spawning any subprocess.
 *
 * Subcommand normalisation: `subcommand` is authored kebab-cased in
 * the role spec (so it stays a valid YAML identifier and matches the
 * `gh` CLI's actual segment shape). The wrapper splits on `-` before
 * invoking `gh`, so `pr-view` becomes `["pr", "view"]` in the spawned
 * command, matching `gh pr view`.
 *
 * `gh_allow_args` is reserved for forward-compat with Story 2.x /
 * Epic 3 (placeholder substitution). The v1 matching rule is exact
 * string match — no template substitution. Shipped v1 specs leave
 * `gh_allow_args` empty.
 *
 * This wrapper does NOT classify recoverable errors (NFR18 /
 * `gh-error-map.yaml` lands in a later story), does NOT retry, does
 * NOT handle auth (we inherit the user's `gh` auth), does NOT write
 * telemetry. Single-purpose.
 *
 * The `execaImpl` option is a test seam — production callers do not
 * pass it. Tests inject a `vi.fn()` to verify zero-spawn behaviour
 * on negative paths and to stub success on positive paths.
 */
export declare function gh(opts: {
    role: string;
    permissions: RolePermissions;
    subcommand: string;
    args?: readonly string[];
    execaImpl?: typeof defaultExeca;
}): Promise<GhCallResult>;
