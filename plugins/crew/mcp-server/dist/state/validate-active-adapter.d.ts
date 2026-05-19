import type { PlanningAdapter } from "../adapters/adapter.js";
import type { Workspace } from "./workspace-resolver.js";
export interface ValidateActiveAdapterOptions {
    /** Override registered adapters. Test seam; defaults to the live registry. */
    adapters?: PlanningAdapter[];
}
/**
 * Verify that the workspace's configured adapter still recognises the
 * target repo. Intended to be called by every skill, once per invocation,
 * immediately after `resolveWorkspace` and before any other work.
 *
 * Returns the same Workspace reference on success (identity-preserving),
 * so callers can chain: `await validateActiveAdapter(await resolveWorkspace(...))`.
 *
 * Throws StaleWorkspaceConfigError if the configured adapter rejects the
 * repo. The error message redirects the user to another matching adapter
 * if one exists, otherwise points at the schema and canonical example.
 */
export declare function validateActiveAdapter(workspace: Workspace, opts?: ValidateActiveAdapterOptions): Promise<Workspace>;
