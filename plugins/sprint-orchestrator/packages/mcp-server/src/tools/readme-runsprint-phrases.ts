/**
 * Locked phrases the README's "Running a sprint" section must contain
 * verbatim. The e2e harness asserts on these constants directly so the
 * docs-build and the asserted contract are the same string by
 * construction (same discipline as `format-end-of-run-line.ts` and
 * `readme-adopt-phrases.ts`).
 *
 * goal-adoption sprint, story 3 — README documents the new run-sprint
 * output flow (last-line /goal command, fresh-context rationale, and
 * the deferred clipboard auto-copy with link to follow-ups.md).
 */

/**
 * Rationale the README must show next to the run-sprint flow, explaining
 * WHY the user is asked to paste the /goal line into a fresh context
 * window. The same rationale is repeated in the on-screen output of
 * run-sprint via FRESH_CONTEXT_GUIDANCE_LINE; the README anchors the
 * reasoning so users who skip the inline note still see it.
 *
 * Must appear verbatim in the "Running a sprint" section so e2e and
 * prose cannot drift.
 */
export const FRESH_CONTEXT_RATIONALE =
  "Paste the /goal command in a fresh context window. A clean transcript gives the /goal evaluator the best chance of correctly deciding when the drain condition is met.";

/**
 * Unambiguous phrase locking the contract that the canonical /goal
 * command is printed as the FINAL line of run-sprint's stdout. The
 * exact wording is asserted by e2e against the "Running a sprint"
 * section.
 */
export const GOAL_FINAL_LINE_STATEMENT =
  "The wrapper prints the canonical /goal command as the final line of its output, so you can triple-click the last line to copy it.";

/**
 * One-line user-facing opt-out instruction. Reserved for the future
 * harness-change path when OSC 52 clipboard auto-copy actually works —
 * keep this exported so the README and the wrapper share one phrasing
 * the moment the gate is flipped on. NOT asserted by e2e in the
 * spike-failed path (the README acknowledges deferral instead).
 */
export const CLIPBOARD_OPT_OUT_INSTRUCTION =
  "If your terminal renders OSC 52 sequences as garbage characters, set SPRINT_ORCHESTRATOR_NO_CLIPBOARD=1 to disable the clipboard auto-copy.";

/**
 * Sentence the README must contain when the OSC 52 clipboard auto-copy
 * path is deferred (Story 2 spike failed). Acknowledges that clipboard
 * auto-copy does not ship in this sprint and points at the deferred-work
 * tracker so a future reader knows where the follow-up lives.
 *
 * Must appear verbatim in the "Running a sprint" section.
 */
export const CLIPBOARD_DEFERRED_ACKNOWLEDGEMENT =
  "Clipboard auto-copy of the /goal command was investigated this sprint but does not ship — it is tracked as a follow-up. See `_bmad-output/planning-artifacts/follow-ups.md` for the spike notes and promotion criteria.";
