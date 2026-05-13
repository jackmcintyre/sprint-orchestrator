/**
 * Model-tiering v1 — static default model IDs for orchestrator-spawned
 * subagents. Centralised here so the resolver, the agent files, the config
 * schema, and the e2e harness all reference the same string literals and
 * cannot drift.
 *
 * Resolution order (see `resolve-spawn-model.ts`):
 *   1. `config.models[role]` if set in `.sprint-orchestrator/config.yaml`
 *   2. The agent file's `model:` frontmatter field
 *   3. The matching `DEFAULT_*_MODEL` constant in this module
 *
 * The fallback exists so the resolver works in tests that do not ship
 * agent files alongside the temp repo. v1 deliberately does not include
 * rework-based escalation — that branch lands in Story 2.
 */

/** Sonnet 4.6 — the default workhorse for routine dev + reviewer spawns. */
export const SONNET_MODEL_ID = "claude-sonnet-4-6";

/** Opus 4.7 — reserved for the rework-escalation branch in Story 2. */
export const OPUS_MODEL_ID = "claude-opus-4-7";

/**
 * Model the resolver returns for a dev re-spawn after one or more rework
 * swings. Locked by the model-tiering-v1 brief: "dev attempts after rework
 * run on Opus." Reviewer is never escalated by this rule.
 */
export const DEEP_MODEL = "claude-opus-4-7";

/** Fallback dev-role model used when neither config nor frontmatter set one. */
export const DEFAULT_DEV_MODEL = SONNET_MODEL_ID;

/** Fallback reviewer-role model used when neither config nor frontmatter set one. */
export const DEFAULT_REVIEWER_MODEL = SONNET_MODEL_ID;

/** Roles the resolver knows how to look up. */
export type SpawnRole = "dev" | "reviewer";

/** Fallback model ID for a given role, used when resolution drops to step 3. */
export function defaultModelForRole(role: SpawnRole): string {
  return role === "dev" ? DEFAULT_DEV_MODEL : DEFAULT_REVIEWER_MODEL;
}
