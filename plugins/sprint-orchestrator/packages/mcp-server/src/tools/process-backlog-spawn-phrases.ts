/**
 * Phrase-lock for the `process-backlog` skill's resolveSpawnModel call.
 *
 * The `process-backlog` SKILL.md instructs the orchestrator to call the
 * MCP tool `resolveSpawnModel` immediately before each `Task` spawn (dev
 * + reviewer) and pass the returned model ID via Task's `model`
 * parameter. The exact sentence below appears verbatim in SKILL.md and
 * is asserted by the e2e harness so the skill prose and the resolver
 * contract cannot drift.
 *
 * Story 1 of the model-tiering-v1 sprint locks the wording; later
 * stories (rework-based escalation, telemetry) extend behaviour without
 * changing this phrase.
 */
export const RESOLVE_SPAWN_MODEL_INSTRUCTION =
  "Before this Task spawn, call the MCP tool `resolveSpawnModel` with the story ID and the role (`dev` or `reviewer`) and pass the returned model ID via Task's `model` parameter.";
