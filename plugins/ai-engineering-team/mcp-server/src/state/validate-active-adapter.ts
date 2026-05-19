import type { PlanningAdapter } from "../adapters/adapter.js";
import { adapters as registryAdapters } from "../adapters/registry.js";
import { StaleWorkspaceConfigError } from "../errors.js";
import type { Workspace } from "./workspace-resolver.js";

const SCHEMA_MODULE = "mcp-server/src/schemas/workspace-config.ts";

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
export async function validateActiveAdapter(
  workspace: Workspace,
  opts?: ValidateActiveAdapterOptions,
): Promise<Workspace> {
  const adapters = opts?.adapters ?? registryAdapters;

  const configuredMatches = await workspace.activeAdapter.detect(workspace.targetRepoRoot);
  if (configuredMatches) {
    return workspace;
  }

  // Cross-check against other registered adapters. Filter the configured
  // adapter out so detect() runs at most once per registered adapter.
  const others = adapters.filter((a) => a.name !== workspace.activeAdapterName);
  const otherResults = await Promise.all(others.map((a) => a.detect(workspace.targetRepoRoot)));
  const otherMatchingAdapters = others
    .filter((_, i) => otherResults[i] === true)
    .map((a) => a.name);

  throw new StaleWorkspaceConfigError({
    targetRepoRoot: workspace.targetRepoRoot,
    configuredAdapter: workspace.activeAdapterName,
    otherMatchingAdapters,
    schemaModule: SCHEMA_MODULE,
  });
}
