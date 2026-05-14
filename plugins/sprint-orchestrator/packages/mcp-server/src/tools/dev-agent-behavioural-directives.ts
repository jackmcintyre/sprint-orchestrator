/**
 * Phrase-locked behavioural directives injected into the dev subagent's
 * system prompt (`plugins/sprint-orchestrator/agents/dev.md`).
 *
 * These strings are the single source of truth: agents/dev.md must
 * contain each constant verbatim, and the e2e mini-run "agents/dev.md
 * contains mandatory tool-call and decide-and-ship directives verbatim"
 * asserts that contract so the prose and the constants cannot drift.
 *
 * Background — orchestrator-hardening sprint, story 2:
 *
 * During the hardening sprint the dev subagent stalled mid-research on
 * 3 of 5 stories. Two patterns emerged:
 *
 *   1. Required tool calls buried in story notes (e.g. `markDevReturned`)
 *      were skipped because they were described as prose rather than
 *      surfaced as an explicit task.
 *
 *   2. When a story had a decision point with multiple viable approaches,
 *      the dev returned with a question instead of picking one and
 *      shipping.
 *
 * Both directives below tighten the dev behavioural contract so the
 * orchestrator stops bleeding spawns on these patterns.
 */

export const MANDATORY_TOOL_CALL_DIRECTIVE =
  "If the story names a specific MCP tool you must call (e.g. `markDevReturned`), call it as part of completing the story. Do not return without calling it.";

export const DECIDE_AND_SHIP_DIRECTIVE =
  "When a story has a decision point with multiple viable approaches, pick one and ship. Do not return to ask the PM unless the spec is genuinely ambiguous (missing field names, contradictory ACs, no way to satisfy the AC). 'Could this be done better?' is not ambiguity — it's a design judgment the dev owns.";
