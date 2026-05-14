/**
 * Phrase-locked refusal message for the run-sprint preflight check that
 * blocks launching a sprint when `sprint-status.yaml` has uncommitted
 * changes in the cwd's git repo.
 *
 * Background: during the hardening sprint launch, sprint-status.yaml was
 * never committed. When the first story PR merged to main, the merge
 * overwrote the live backlog file. Manual recovery from a dangling git
 * blob was scrappy and one-off; an external user hitting this would
 * lose their backlog with no recovery path.
 *
 * Same lock-it-once discipline as `run-sprint-output-format.ts`: the
 * skill, the planner, and the e2e harness all reference this constant
 * so prose and behaviour cannot drift.
 */

/**
 * Verbatim refusal message emitted when `sprint-status.yaml` has
 * uncommitted changes (untracked, modified, or staged-but-not-committed).
 * The skill MUST emit this string and stop; the planner returns it as
 * `result.message` under `reason: "uncommitted_backlog"`.
 */
export const UNCOMMITTED_BACKLOG_REFUSAL =
  "refusing to launch: sprint-status.yaml has uncommitted changes. " +
  "Commit it before running — otherwise a story PR merging to main mid-run " +
  "can overwrite the live backlog and require manual recovery from a dangling git blob.";
