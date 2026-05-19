import { execa as defaultExeca } from "execa";
import { GhSubcommandDeniedError } from "../errors.js";
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
export async function gh(opts) {
    const { role, permissions, subcommand } = opts;
    const args = opts.args ?? [];
    const execaImpl = opts.execaImpl ?? defaultExeca;
    if (!permissions.gh_allow.includes(subcommand)) {
        throw new GhSubcommandDeniedError({
            role,
            attemptedSubcommand: subcommand,
            allowedSubcommands: permissions.gh_allow,
            specPath: permissions.sourcePath,
        });
    }
    // v1 gh_allow_args enforcement: exact-string match only.
    const allowedArgs = permissions.gh_allow_args[subcommand];
    if (allowedArgs && allowedArgs.length > 0) {
        for (const candidate of args) {
            if (!allowedArgs.includes(candidate)) {
                throw new GhSubcommandDeniedError({
                    role,
                    attemptedSubcommand: `${subcommand} ${candidate}`,
                    allowedSubcommands: allowedArgs,
                    specPath: permissions.sourcePath,
                });
            }
        }
    }
    // Translate kebab-cased subcommand into space-separated gh segments.
    const segments = subcommand.split("-");
    const result = await execaImpl("gh", [...segments, ...args]);
    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
    };
}
