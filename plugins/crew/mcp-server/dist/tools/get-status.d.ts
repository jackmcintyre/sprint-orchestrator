import type { PlanningAdapter } from "../adapters/adapter.js";
import { type StatusReport } from "../schemas/status-report.js";
export interface GetStatusOptions {
    targetRepoRoot: string;
    /**
     * Optional adapter override. Test seam — mirrors the same seam on
     * `resolveWorkspace` and `validateActiveAdapter`. Production callers
     * (the MCP tool handler) never pass this; the live registry is used.
     */
    adapters?: PlanningAdapter[];
}
/**
 * Compose `getPluginVersion`, `resolveWorkspace`, `validateActiveAdapter`,
 * and `lookupStandards` into a single typed report describing whether the
 * plugin sees the user's repo (Story 1.7).
 *
 * Algorithm (do not deviate):
 *  1. Read the plugin semver from the manifest.
 *  2. Resolve the workspace. Hard failures (no adapter, ambiguous adapter,
 *     invalid config) propagate; the skill body surfaces them via the
 *     standard MCP error path.
 *  3. Validate the active adapter. Only `StaleWorkspaceConfigError` is
 *     caught and projected into a downgraded `adapter.state = "mismatched"`
 *     report — every other error is a bug and must surface.
 *  4. Lookup standards. `StandardsDocMissingError` → `standards.state =
 *     "missing"`; `StandardsDocMalformedError` → `standards.state =
 *     "malformed"` carrying `zodMessage`. Both are downgrades, not failures.
 *  5. Validate the assembled report against `StatusReportSchema` before
 *     returning — defends against future field drift.
 *
 * No cache, no telemetry, no direct IO. Every read goes through an
 * existing primitive.
 */
export declare function getStatus(opts: GetStatusOptions): Promise<StatusReport>;
/**
 * Pure formatter — no IO, no clock. Returns the five canonical status
 * lines joined by `\n`, with NO trailing newline. The MCP tool wraps
 * the string in a `{ type: "text", text }` content block.
 */
export declare function renderStatus(report: StatusReport): string;
